/**
 * Coordinate bounded provider retention inspection and pruning under repository lifecycle authority.
 *
 * Invariants:
 * - Eligibility checks, catalog cursors, hooks, and transaction ordering stay exact.
 * - Runtime resolution stays lazy; receipt exports retain their original behavior.
 */

import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type EvidenceRetentionRecord } from '../../modules/authority/execution-governance-retention.ts';
import { readDurableEvidence } from '../storage-journal/execution-governance-evidence-store.ts';
import { providerRuntimeEvidenceId } from './provider-execution-governance.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import { listProviderInvocationLifecycleProjections } from '../storage-journal/provider-invocation-lifecycle.ts';
import { privatePathExists } from '../storage-journal/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { SessionRuntimeLayoutV1 } from '@jigwright/core/session-runtime-layout-port';
import { classifyProviderRetentionEligibility } from '../../modules/provider-orchestration/provider-retention.ts';
import type {
  ProviderRetentionDenyReason,
  ProviderRetentionPassResult,
  ProviderRetentionOptions,
  ProviderRetentionHooks,
  ProviderRetentionMetrics,
} from '../../modules/provider-orchestration/provider-retention.ts';

export type ProviderRetentionRuntimeResolver = (cwd: string) => {
  runtime: InvestigationRuntimePaths;
  lifecycleRuntime: SessionRuntimeLayoutV1;
};
import { readProviderInvocation } from '../storage-journal/provider-invocation-store.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import {
  readProviderRetentionReceipt,
  providerRetentionReceiptPath,
} from '../storage-journal/provider-retention-receipt.ts';
import {
  readProviderRetentionCatalogBatch,
  commitProviderRetentionCatalogCursor,
} from '../storage-journal/provider-retention-catalog.ts';
import { withRepositoryLifecycleOperation } from '../session-workspace/session-store.ts';
import {
  assertTtlDays,
  PROVIDER_RETENTION_DEFAULT_TTL_DAYS,
  parseTimestamp,
  runtimeUnsafe,
  receiptUnsafe,
  deepFreeze,
  assertLimit,
  PROVIDER_RETENTION_MAX_TTL_DAYS,
} from './provider-retention-values.ts';
import {
  humanPinResolver,
  readInvocationBinding,
  assertReceiptBinding,
  type InvocationBinding,
  decideCandidate,
} from './provider-retention-observation.ts';
import { collectPhysicalArtifacts } from './provider-retention-artifacts.ts';
import { ensureRetentionDirectories } from './provider-retention-files.ts';
import {
  recoverInterruptedPruning,
  cleanupCompletedReceipt,
  prepareReceipt,
  completePreparedReceipt,
} from './provider-retention-transaction.ts';

export {
  PROVIDER_RETENTION_MAX_RECEIPT_BYTES,
  providerRetentionReceiptPath,
  readProviderRetentionReceipt,
} from '../storage-journal/provider-retention-receipt.ts';
export { providerRuntimeEvidenceId };
export {
  PROVIDER_RETENTION_DEFAULT_TTL_DAYS,
  PROVIDER_RETENTION_MAX_TTL_DAYS,
  PROVIDER_RETENTION_MAX_LIMIT,
} from './provider-retention-values.ts';

/**
 * Derive storage metrics from the same strict invocation, Attempt, context,
 * and receipt bindings used by the physical pruning pass. A partial receipt or
 * unprovable lineage fails closed instead of reporting a reassuring estimate.
 */
export function inspectProviderRetentionMetrics(
  resolveRuntime: ProviderRetentionRuntimeResolver,
  cwd: string,
  options: { now?: string; ttlDays?: number } = {},
): ProviderRetentionMetrics {
  const ttlDays = assertTtlDays(
    options.ttlDays ?? PROVIDER_RETENTION_DEFAULT_TTL_DAYS,
  );
  const now = parseTimestamp(options.now ?? new Date().toISOString());
  const cutoffAt = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
  const context = resolveRuntime(cwd);
  return withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      assertOwned();
      const rawEvidenceBytesByRetentionClass = {
        active: 0,
        debug: 0,
        pinned: 0,
      };
      let expiredPendingCount = 0;
      let expiredPendingBytes = 0;
      let pinnedCount = 0;
      let receiptCount = 0;
      // The pins the pruning pass obeys, so the number reported here is the
      // number that actually withholds bytes. AttemptRecord.retention alone
      // never says 'pinned' in production, which is what made this metric a
      // structural zero.
      const resolveHumanPins = humanPinResolver(context.runtime.root);
      for (const projection of listProviderInvocationLifecycleProjections(
        context.runtime,
      )) {
        assertOwned();
        const record = readProviderInvocation(
          context.runtime,
          projection.invocationId,
        );
        const binding = readInvocationBinding(context.runtime, record);
        if (binding === undefined) throw runtimeUnsafe();
        const receipt = readProviderRetentionReceipt(
          context.runtime,
          record.invocationId,
        );
        const humanPinned = resolveHumanPins(binding.context.workflowId).has(
          providerRuntimeEvidenceId(binding.attempt.attemptId),
        );
        if (receipt !== null) {
          assertReceiptBinding(receipt, binding, record);
          if (receipt.state !== 'complete') throw receiptUnsafe();
          receiptCount += 1;
          if (humanPinned || receipt.attemptRetention === 'pinned') {
            pinnedCount += 1;
          }
          continue;
        }
        const artifacts = collectPhysicalArtifacts(context.runtime, binding);
        const bytes = artifacts.reduce(
          (total, artifact) => total + artifact.bytes,
          0,
        );
        const retentionClass = humanPinned
          ? 'pinned'
          : binding.attempt.retention;
        rawEvidenceBytesByRetentionClass[retentionClass] += bytes;
        if (retentionClass === 'pinned') pinnedCount += 1;
        if (
          privatePathExists(
            context.runtime,
            path.join(
              context.runtime.invocations,
              record.invocationId,
              'repair-evidence.json',
            ),
            runtimeUnsafe,
          )
        ) {
          continue;
        }
        const denial = classifyProviderRetentionEligibility({
          invocationState: record.state,
          historyComplete: binding.state.invocationProjection.completeHistory,
          attemptEpoch: binding.context.epoch,
          currentEpoch: binding.context.currentEpoch,
          retention: binding.attempt.retention,
          acceptedAttempt:
            binding.state.job.acceptedAttemptId === binding.attempt.attemptId,
          latestUnacceptedAttempt:
            binding.state.job.acceptedAttemptId === null &&
            binding.attempt.attemptNumber ===
              Math.max(
                ...binding.state.attempts.map(
                  ({ attemptNumber }) => attemptNumber,
                ),
              ),
          terminalAt: record.updatedAt,
          cutoffAt,
          humanPinned,
        });
        if (denial === null && bytes > 0) {
          expiredPendingCount += 1;
          expiredPendingBytes += bytes;
        }
      }
      assertOwned();
      return deepFreeze({
        schemaVersion: 1 as const,
        kind: 'provider-retention-metrics' as const,
        measuredAt: now.toISOString(),
        ttlDays,
        rawEvidenceBytesByRetentionClass,
        expiredPendingDeletion: {
          count: expiredPendingCount,
          bytes: expiredPendingBytes,
        },
        pinnedCount,
        receiptCount,
      });
    },
  );
}

/**
 * Rejects a provider-runtime pin once the physical pruning transaction has
 * published a receipt. Callers must hold the repository lifecycle lock across
 * this check and the subsequent catalog pin so a sweep cannot consume a cached
 * no-pin decision between them.
 */
export function assertProviderRuntimeEvidencePinnableUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  record: EvidenceRetentionRecord,
): void {
  if (!record.evidenceId.startsWith('provider-runtime-')) return;

  let descriptor: Record<string, unknown>;
  try {
    const value = JSON.parse(
      readDurableEvidence(paths.root, record.workflowId, record.evidenceId)
        .content,
    ) as unknown;
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort()) !==
        canonicalJson(
          [
            'attemptId',
            'epoch',
            'invocationId',
            'kind',
            'invocationRevision',
            'workflowId',
          ].sort(),
        )
    ) {
      throw runtimeUnsafe();
    }
    descriptor = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw runtimeUnsafe();
  }

  if (
    descriptor.kind !== 'provider-runtime-evidence.v1' ||
    typeof descriptor.workflowId !== 'string' ||
    descriptor.workflowId !== record.workflowId ||
    typeof descriptor.attemptId !== 'string' ||
    typeof descriptor.invocationId !== 'string' ||
    !Number.isSafeInteger(descriptor.epoch) ||
    descriptor.epoch !== record.epoch ||
    !Number.isSafeInteger(descriptor.invocationRevision) ||
    (descriptor.invocationRevision as number) < 0 ||
    record.itemIdentity !== `attempt:${descriptor.attemptId}` ||
    record.evidenceId !== providerRuntimeEvidenceId(descriptor.attemptId)
  ) {
    throw runtimeUnsafe();
  }

  let providerRecord: ProviderInvocationRecord;
  let binding: InvocationBinding | undefined;
  try {
    providerRecord = readProviderInvocation(
      paths,
      descriptor.invocationId as string,
    );
    binding = readInvocationBinding(paths, providerRecord);
  } catch {
    throw runtimeUnsafe();
  }
  if (
    binding === undefined ||
    binding.context.workflowId !== record.workflowId ||
    binding.context.epoch !== record.epoch ||
    binding.attempt.attemptId !== descriptor.attemptId ||
    binding.attempt.providerInvocation?.invocationId !== descriptor.invocationId
  ) {
    throw runtimeUnsafe();
  }

  const receipt = readProviderRetentionReceipt(
    paths,
    descriptor.invocationId as string,
  );
  if (receipt === null) return;
  assertReceiptBinding(receipt, binding, providerRecord);
  throw workflowError(
    'RETENTION_EVIDENCE_ALREADY_PRUNED',
    `Provider runtime evidence ${record.evidenceId} has already entered physical pruning and cannot be pinned.`,
    ExitCode.guard,
  );
}

/**
 * Run one bounded physical retention pass. Eligibility comes only from the
 * exact durable Job/Attempt projection; incomplete state that cannot prove its
 * current, epoch, and pin status is retained with an explicit deny reason.
 */
export function pruneProviderRuntime(
  resolveRuntime: ProviderRetentionRuntimeResolver,
  cwd: string,
  options: ProviderRetentionOptions,
  hooks: ProviderRetentionHooks = {},
): ProviderRetentionPassResult {
  const limit = assertLimit(options.limit);
  const ttlDays = assertTtlDays(
    options.ttlDays ?? PROVIDER_RETENTION_DEFAULT_TTL_DAYS,
  );
  const now = parseTimestamp(options.now ?? new Date().toISOString());
  const cutoffAt = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
  const context = resolveRuntime(cwd);

  return withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      assertOwned();
      ensureRetentionDirectories(context.runtime);
      // Pins are resolved against the store the durable provider contexts are
      // actually written to. Reading the lifecycle root instead looked at a
      // different directory entirely, so no pin could ever be found here.
      const resolveHumanPins = humanPinResolver(context.runtime.root);
      const recovered: string[] = [];
      let remaining = limit;

      // A transaction creates its staging directory before publishing the
      // prepared receipt and completes one invocation before starting another.
      // Consequently there is at most one crash-recovery item, independent of
      // total history size.
      const recoveredInvocation = recoverInterruptedPruning(
        context.runtime,
        now,
        assertOwned,
        hooks,
      );
      if (recoveredInvocation !== null) {
        recovered.push(recoveredInvocation);
        remaining -= 1;
      }

      const denied: ProviderRetentionPassResult['denied'][number][] = [];
      let deniedCount = 0;
      const pruned: ProviderRetentionPassResult['pruned'][number][] = [];
      let examined = 0;
      const batch = readProviderRetentionCatalogBatch(
        context.runtime,
        remaining,
      );
      for (const { invocationId } of batch.entries) {
        examined += 1;
        const record = readProviderInvocation(context.runtime, invocationId);
        const binding = readInvocationBinding(context.runtime, record);
        const existing = readProviderRetentionReceipt(
          context.runtime,
          record.invocationId,
        );
        if (existing?.state === 'complete') {
          assertReceiptBinding(existing, binding, record);
          cleanupCompletedReceipt(context.runtime, existing, assertOwned);
          recordDenied('already-pruned');
          continue;
        }
        if (existing !== null) throw receiptUnsafe();

        const decision = decideCandidate(
          context.runtime,
          record,
          binding,
          cutoffAt,
          binding === undefined
            ? new Set<string>()
            : // Pins live in the provider prompt context's catalog, which is
              // the durable store this invocation's evidence actually belongs
              // to. Resolving them under the investigation's own identity read
              // a catalog that never holds a record, so every pin was invisible
              // here however carefully it had been recorded.
              resolveHumanPins(binding.context.workflowId),
        );
        if (decision.kind === 'deny') {
          recordDenied(decision.reason);
          continue;
        }
        const receipt = prepareReceipt(
          context.runtime,
          decision.binding,
          decision.artifacts,
          ttlDays,
          cutoffAt,
          now.toISOString(),
          assertOwned,
        );
        const complete = completePreparedReceipt(
          context.runtime,
          receipt,
          now,
          assertOwned,
          hooks,
        );
        pruned.push({
          invocationId: record.invocationId,
          receiptId: complete.receiptId,
          receiptPath: providerRetentionReceiptPath(
            context.runtime,
            record.invocationId,
          ),
          artifactCount: decision.artifacts.length,
          bytes: decision.artifacts.reduce(
            (sum, artifact) => sum + artifact.bytes,
            0,
          ),
        });

        function recordDenied(reason: ProviderRetentionDenyReason): void {
          deniedCount += 1;
          if (denied.length < limit) {
            denied.push({ invocationId: record.invocationId, reason });
          }
        }
      }
      commitProviderRetentionCatalogCursor(context.runtime, batch);

      return deepFreeze({
        schemaVersion: 1,
        kind: 'provider-runtime-prune-pass',
        policy: {
          schemaVersion: 1,
          ttlDays,
          maxTtlDays: PROVIDER_RETENTION_MAX_TTL_DAYS,
          cutoffAt,
          limit,
        },
        examined,
        recovered,
        pruned,
        deniedCount,
        denied,
        deniedTruncated: deniedCount > denied.length,
      });
    },
  );
}
