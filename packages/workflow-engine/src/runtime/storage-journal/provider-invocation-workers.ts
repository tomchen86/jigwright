/**
 * Manage provider leases, worker fences, quiescence, and repository lifecycle locking.
 *
 * Invariants:
 * - Lock nesting, lease generations, fence tokens, and expiry decisions stay exact.
 * - A live or unresolved worker cannot be silently treated as quiescent.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  createPrivateCanonicalJson,
  withPrivateRuntimeLock,
  privatePathExists,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertInvocationId } from '../../foundation/repository-path/repository-path.ts';
import {
  withRepositoryLifecycleOperation,
  runtimePaths,
} from '../session-workspace/session-store.ts';
import type {
  ProviderLeaseClaim,
  ProviderWorkerClaimInput,
  ProviderWorkerLeaseClaim,
} from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import { readProviderInvocationRequest } from './provider-invocation-artifacts.ts';
import {
  leaseInvalid,
  parseNow,
  sha256,
  PROVIDER_COMPLETION_GRACE_MS,
  providerWorkerFenceUnsafe,
  fsyncDirectory,
  invocationLockInvalid,
  isRecord,
  hasExactKeys,
  isDigest,
  isTimestamp,
  providerSha256,
} from './provider-invocation-common.ts';
import {
  updateProviderInvocation,
  assertProviderInvocationNotTerminallyResolved,
  readProviderInvocation,
} from './provider-invocation-state.ts';

export function claimProviderInvocation(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: ProviderWorkerClaimInput,
): ProviderLeaseClaim {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  if (
    typeof input.workerId !== 'string' ||
    input.workerId.trim().length === 0 ||
    Buffer.byteLength(input.workerId, 'utf8') > 256 ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > request.limits.timeoutMs
  ) {
    throw leaseInvalid();
  }
  const now = parseNow(input.now);
  return withProviderWorkerLifecycle(paths, () =>
    claimProviderInvocationUnderLifecycleLock(paths, invocationId, input, now),
  );
}

export function claimProviderInvocationForWorker(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: ProviderWorkerClaimInput,
): ProviderWorkerLeaseClaim {
  return withProviderWorkerLifecycle(paths, (assertOwned) =>
    claimProviderInvocationForWorkerUnderLifecycleLock(
      paths,
      requestedInvocationId,
      input,
      assertOwned,
    ),
  );
}

export function claimProviderInvocationForWorkerUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: ProviderWorkerClaimInput,
  assertOwned: () => void,
): ProviderWorkerLeaseClaim {
  const invocationId = assertInvocationId(requestedInvocationId);
  const request = readProviderInvocationRequest(paths, invocationId);
  if (
    typeof input.workerId !== 'string' ||
    input.workerId.trim().length === 0 ||
    Buffer.byteLength(input.workerId, 'utf8') > 256 ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > request.limits.timeoutMs
  ) {
    throw leaseInvalid();
  }
  const now = parseNow(input.now);
  assertOwned();
  const claim = claimProviderInvocationUnderLifecycleLock(
    paths,
    invocationId,
    input,
    now,
  );
  const workerFenceToken = crypto.randomUUID();
  createProviderWorkerFence(paths, claim.record, workerFenceToken);
  assertOwned();
  return { ...claim, workerFenceToken };
}

function claimProviderInvocationUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  input: {
    workerId: string;
    leaseDurationMs: number;
    expectedRevision?: number;
  },
  now: number,
): ProviderLeaseClaim {
  const leaseToken = crypto.randomBytes(32).toString('hex');
  const record = updateProviderInvocation(
    paths,
    invocationId,
    input.expectedRevision,
    (current) => {
      assertProviderInvocationNotTerminallyResolved(paths, current);
      if (
        current.state === 'leased' &&
        current.lease !== null &&
        now >= Date.parse(current.lease.expiresAt)
      ) {
        throw workflowError(
          'PROVIDER_INVOCATION_LEASE_EXPIRED',
          'Provider invocation lease expired and requires explicit recovery.',
          ExitCode.staleState,
        );
      }
      if (current.state !== 'prepared') {
        throw workflowError(
          'PROVIDER_INVOCATION_LEASE_CONFLICT',
          'Provider invocation is not prepared or already has a lease.',
          ExitCode.conflict,
        );
      }
      const generation = current.leaseGeneration + 1;
      return {
        ...current,
        revision: current.revision + 1,
        state: 'leased',
        leaseGeneration: generation,
        lease: {
          generation,
          workerId: input.workerId,
          tokenDigest: sha256(leaseToken),
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(
            now + input.leaseDurationMs + PROVIDER_COMPLETION_GRACE_MS,
          ).toISOString(),
        },
        result: null,
        failure: null,
        updatedAt: new Date(now).toISOString(),
      };
    },
  );
  return { record, leaseToken };
}

type ProviderWorkerFence = {
  schemaVersion: 1;
  kind: 'provider-worker-fence';
  invocationId: string;
  leaseGeneration: number;
  workerId: string;
  leaseTokenDigest: string;
  ownerToken: string;
  pid: number;
  acquiredAt: string;
};

function createProviderWorkerFence(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  ownerToken: string,
): void {
  if (record.state !== 'leased' || record.lease === null) {
    throw providerWorkerFenceUnsafe();
  }
  const fence: ProviderWorkerFence = {
    schemaVersion: 1,
    kind: 'provider-worker-fence',
    invocationId: record.invocationId,
    leaseGeneration: record.leaseGeneration,
    workerId: record.lease.workerId,
    leaseTokenDigest: record.lease.tokenDigest,
    ownerToken,
    pid: process.pid,
    acquiredAt: record.lease.acquiredAt,
  };
  createPrivateCanonicalJson(
    paths,
    providerWorkerFencePath(paths, record.invocationId),
    fence,
    providerWorkerFenceUnsafe,
    'PROVIDER_INVOCATION_WORKER_FENCE_CONFLICT',
  );
}

export function releaseProviderInvocationWorkerFence(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  ownerToken: string,
): void {
  withProviderWorkerLifecycle(paths, (assertOwned) =>
    releaseProviderInvocationWorkerFenceUnderLifecycleLock(
      paths,
      requestedInvocationId,
      ownerToken,
      assertOwned,
    ),
  );
}

export function releaseProviderInvocationWorkerFenceForWorkerClaim(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: Readonly<{
    leaseGeneration: number;
    leaseToken: string;
    workerFenceToken: string;
  }>,
): void {
  const invocationId = assertInvocationId(requestedInvocationId);
  withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${invocationId}.lock`),
    () => {
      assertProviderWorkerFenceClaim(paths, invocationId, input);
      fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
      fsyncDirectory(paths.locks);
    },
    'PROVIDER_INVOCATION_OPERATION_CONFLICT',
    invocationLockInvalid,
  );
}

export function releaseProviderInvocationWorkerFenceUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  ownerToken: string,
  assertOwned: () => void,
): void {
  const invocationId = assertInvocationId(requestedInvocationId);
  assertOwned();
  const fence = readProviderWorkerFence(paths, invocationId);
  if (
    fence === null ||
    fence.ownerToken !== ownerToken ||
    fence.pid !== process.pid
  ) {
    throw providerWorkerFenceUnsafe();
  }
  assertOwned();
  fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
  fsyncDirectory(paths.locks);
  assertOwned();
}

export function assertProviderWorkersQuiescentUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
): void {
  const stats = fs.lstatSync(paths.locks, { throwIfNoEntry: false });
  if (!stats) {
    return;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw providerWorkerFenceUnsafe();
  }
  const suffix = '.worker-active';
  for (const entry of fs
    .readdirSync(paths.locks, { withFileTypes: true })
    .filter(({ name }) => name.endsWith(suffix))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw providerWorkerFenceUnsafe();
    }
    const invocationId = assertInvocationId(
      entry.name.slice(0, -suffix.length),
    );
    assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
      paths,
      invocationId,
    );
  }
}

export function assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  options: {
    allowDeadLeasedFence?: boolean;
  } = {},
): void {
  const fence = readProviderWorkerFence(paths, invocationId);
  if (fence === null) {
    return;
  }
  const invocation = readProviderInvocation(paths, invocationId);
  if (
    invocation.leaseGeneration !== fence.leaseGeneration ||
    invocation.state === 'prepared' ||
    (invocation.state === 'leased' &&
      (invocation.lease === null ||
        invocation.lease.workerId !== fence.workerId ||
        invocation.lease.tokenDigest !== fence.leaseTokenDigest))
  ) {
    throw providerWorkerFenceUnsafe();
  }
  if (isProcessAlive(fence.pid)) {
    throw workflowError(
      'PROVIDER_INVOCATION_WORKER_ACTIVE',
      'Provider invocation still has a live worker activity fence.',
      ExitCode.conflict,
      { details: { invocationId, pid: fence.pid } },
    );
  }
  if (invocation.state === 'leased') {
    if (options.allowDeadLeasedFence === true) {
      return;
    }
    throw workflowError(
      'PROVIDER_INVOCATION_WORKER_RECOVERY_REQUIRED',
      'A dead provider worker still owns a leased invocation and requires explicit recovery.',
      ExitCode.conflict,
      { details: { invocationId, pid: fence.pid } },
    );
  }
  fs.unlinkSync(providerWorkerFencePath(paths, invocationId));
  fsyncDirectory(paths.locks);
}

export function readProviderWorkerFence(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): ProviderWorkerFence | null {
  const filePath = providerWorkerFencePath(paths, invocationId);
  if (!privatePathExists(paths, filePath, providerWorkerFenceUnsafe)) {
    return null;
  }
  const value = readPrivateCanonicalJson(
    paths,
    filePath,
    providerWorkerFenceUnsafe,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'leaseGeneration',
      'workerId',
      'leaseTokenDigest',
      'ownerToken',
      'pid',
      'acquiredAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-worker-fence' ||
    value.invocationId !== invocationId ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    typeof value.workerId !== 'string' ||
    value.workerId.length === 0 ||
    !isDigest(value.leaseTokenDigest) ||
    typeof value.ownerToken !== 'string' ||
    value.ownerToken.length === 0 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    !isTimestamp(value.acquiredAt)
  ) {
    throw providerWorkerFenceUnsafe();
  }
  return value as ProviderWorkerFence;
}

export function providerWorkerFenceDigest(
  fence: ProviderWorkerFence,
): `sha256:${string}` {
  return providerSha256(
    `workflow.provider-worker-fence.v1\n${canonicalJson(fence)}`,
  );
}

export function assertProviderWorkerFenceClaim(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  input: Readonly<{
    leaseGeneration: number;
    leaseToken: string;
    workerFenceToken: string;
  }>,
): void {
  const fence = readProviderWorkerFence(paths, invocationId);
  if (
    fence === null ||
    fence.leaseGeneration !== input.leaseGeneration ||
    fence.leaseTokenDigest !== sha256(input.leaseToken) ||
    fence.ownerToken !== input.workerFenceToken ||
    fence.pid !== process.pid
  ) {
    throw providerWorkerFenceUnsafe();
  }
}

function providerWorkerFencePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(paths.locks, `${invocationId}.worker-active`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function expireProviderInvocationLease(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    now?: string;
  },
): ProviderInvocationRecord {
  return withProviderWorkerLifecycle(paths, (assertOwned) =>
    expireProviderInvocationLeaseUnderLifecycleLock(
      paths,
      requestedInvocationId,
      input,
      assertOwned,
    ),
  );
}

export function expireProviderInvocationLeaseUnderLifecycleLock(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  input: {
    expectedRevision: number;
    now?: string;
  },
  assertOwned: () => void,
): ProviderInvocationRecord {
  const invocationId = assertInvocationId(requestedInvocationId);
  const now = parseNow(input.now);
  assertOwned();
  assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
    paths,
    invocationId,
    { allowDeadLeasedFence: true },
  );
  const expired = updateProviderInvocation(
    paths,
    invocationId,
    input.expectedRevision,
    (current) => {
      if (
        current.state !== 'leased' ||
        current.lease === null ||
        now < Date.parse(current.lease.expiresAt)
      ) {
        throw workflowError(
          'PROVIDER_INVOCATION_LEASE_NOT_EXPIRED',
          'Provider invocation lease is absent or still current.',
          ExitCode.guard,
        );
      }
      return {
        ...current,
        revision: current.revision + 1,
        state: 'failed',
        lease: null,
        result: null,
        failure: {
          kind: 'retryable',
          code: 'PROVIDER_INVOCATION_LEASE_EXPIRED',
          message:
            'The prior worker lease expired; retry requires a fresh invocation.',
        },
        updatedAt: new Date(now).toISOString(),
      };
    },
  );
  assertOwned();
  assertProviderInvocationWorkerQuiescentUnderLifecycleLock(
    paths,
    invocationId,
  );
  return expired;
}

export function withProviderWorkerLifecycle<T>(
  paths: InvestigationRuntimePaths,
  operation: (assertOwned: () => void) => T,
): T {
  const runtimeRoot = path.dirname(paths.root);
  return withRepositoryLifecycleOperation(
    runtimePaths(path.dirname(runtimeRoot), path.basename(runtimeRoot)),
    operation,
  );
}
