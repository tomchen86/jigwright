/**
 * Stage provider artifacts and finish or recover the exact durable pruning transaction.
 *
 * Invariants:
 * - Prepare, rename, receipt completion, marker creation, and cleanup retain their order.
 * - Both interrupted-prune recovery paths remain with the write transaction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { assertPrivateInvestigationDirectory } from '../journal-primitives/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-store.ts';
import {
  type ProviderRetentionReceipt,
  type ProviderRetentionArtifact,
  providerRetentionReviewRootArtifact,
  providerRetentionStagingDirectory,
  createProviderRetentionReceipt,
  providerRetentionReceiptId,
  providerRetentionReceiptPath,
  canonicalProviderRetentionReceipt,
  PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS,
  providerRetentionRoot,
  readProviderRetentionReceipt,
} from '../storage-journal/provider-retention-receipt.ts';
import { readProviderRetentionCatalogEntry } from '../storage-journal/provider-retention-catalog.ts';
import {
  type InvocationBinding,
  readInvocationBinding,
  assertReceiptBinding,
} from './provider-retention-observation.ts';
import {
  type PhysicalArtifact,
  physicalArtifactsForReceipt,
  observeArtifact,
} from './provider-retention-artifacts.ts';
import {
  runtimeUnsafe,
  sha256,
  receiptUnsafe,
} from './provider-retention-values.ts';
import {
  ensurePrivateDirectory,
  createPrivateFileAtomic,
  fsyncDirectory,
  replacePrivateFileAtomic,
  assertPrivateDirectory,
  HOST_WRAPPER_PROBE_DIRECTORY,
  HOST_WRAPPER_TURN_DIRECTORY,
} from './provider-retention-files.ts';
import type { ProviderRetentionHooks } from '../../modules/provider-orchestration/provider-retention.ts';

export function prepareReceipt(
  paths: InvestigationRuntimePaths,
  binding: InvocationBinding,
  physicalArtifacts: PhysicalArtifact[],
  ttlDays: number,
  cutoffAt: string,
  preparedAt: string,
  assertOwned: () => void,
): ProviderRetentionReceipt {
  if (
    binding.record.state !== 'succeeded' &&
    binding.record.state !== 'failed'
  ) {
    throw runtimeUnsafe();
  }
  const artifacts: ProviderRetentionArtifact[] = [
    ...physicalArtifacts
      .filter(({ receiptName }) => receiptName !== 'review-root')
      .map(({ receiptName: name, digest, bytes }) => ({ name, digest, bytes })),
    ...(physicalArtifacts.some(
      ({ receiptName }) => receiptName === 'review-root',
    )
      ? [
          providerRetentionReviewRootArtifact(
            physicalArtifacts
              .filter(({ receiptName }) => receiptName === 'review-root')
              .map(({ physicalName: name, digest, bytes }) => ({
                name,
                digest,
                bytes,
              })),
          ),
        ]
      : []),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const identity = {
    invocationId: binding.record.invocationId,
    requestDigest: binding.record.requestDigest,
    manifestDigest: binding.record.manifestDigest,
    invocationRevision: binding.record.revision,
    terminalAt: binding.record.updatedAt,
    artifacts,
    workflowId: binding.context.workflowId,
    jobId: binding.state.job.jobId,
    attemptId: binding.attempt.attemptId,
    contextDigest: binding.context.contextDigest,
    epoch: binding.context.epoch,
    currentEpoch: binding.context.currentEpoch,
    executionRevision: binding.state.revision,
    executionStateDigest: sha256(canonicalJson(binding.state)),
    attemptRetention: binding.attempt.retention,
    acceptedAttemptId: binding.state.job.acceptedAttemptId,
  };
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    binding.record.invocationId,
  );
  ensurePrivateDirectory(stagingDirectory);
  if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
  const receipt = createProviderRetentionReceipt({
    schemaVersion: 1,
    kind: 'provider-runtime-prune-receipt',
    state: 'prepared',
    receiptId: providerRetentionReceiptId(identity),
    invocationId: binding.record.invocationId,
    workflowId: binding.context.workflowId,
    jobId: binding.state.job.jobId,
    attemptId: binding.attempt.attemptId,
    contextDigest: binding.context.contextDigest,
    executionRevision: binding.state.revision,
    executionStateDigest: sha256(canonicalJson(binding.state)),
    epoch: binding.context.epoch,
    currentEpoch: binding.context.currentEpoch,
    attemptRetention: binding.attempt.retention,
    acceptedAttemptId: binding.state.job.acceptedAttemptId,
    requestDigest: binding.record.requestDigest,
    manifestDigest: binding.record.manifestDigest,
    invocationRevision: binding.record.revision,
    terminalState: binding.record.state,
    terminalAt: binding.record.updatedAt,
    ttlDays,
    cutoffAt,
    artifacts,
    preparedAt,
    completedAt: null,
  });
  assertOwned();
  createPrivateFileAtomic(
    providerRetentionReceiptPath(paths, binding.record.invocationId),
    canonicalProviderRetentionReceipt(receipt),
  );
  return receipt;
}

export function completePreparedReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
  completedAt: Date,
  assertOwned: () => void,
  hooks: ProviderRetentionHooks,
): ProviderRetentionReceipt {
  if (receipt.state !== 'prepared') throw receiptUnsafe();
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  ensurePrivateDirectory(stagingDirectory);
  let stagedCount = 0;
  for (const artifact of physicalArtifactsForReceipt(paths, receipt)) {
    assertOwned();
    const source = observeArtifact(artifact.sourcePath, artifact);
    const staged = observeArtifact(artifact.stagingPath, artifact);
    if (source && staged) throw runtimeUnsafe();
    if (!source && !staged) {
      throw workflowError(
        'PROVIDER_RETENTION_PRUNING_PARTIAL',
        'Prepared provider pruning lost an artifact before receipt completion.',
        ExitCode.staleState,
      );
    }
    if (source) {
      fs.renameSync(artifact.sourcePath, artifact.stagingPath);
      fsyncDirectory(path.dirname(artifact.sourcePath));
      fsyncDirectory(stagingDirectory);
      if (!observeArtifact(artifact.stagingPath, artifact)) {
        throw runtimeUnsafe();
      }
    }
    stagedCount += 1;
    hooks.afterArtifactStaged?.(stagedCount, receipt.invocationId);
  }
  ensureHostWrapperRetentionMarker(paths, receipt, assertOwned);
  const { receiptDigest: _receiptDigest, ...prepared } = receipt;
  const complete = createProviderRetentionReceipt({
    ...prepared,
    state: 'complete',
    completedAt: completedAt.toISOString(),
  });
  assertOwned();
  replacePrivateFileAtomic(
    providerRetentionReceiptPath(paths, receipt.invocationId),
    canonicalProviderRetentionReceipt(complete),
  );
  hooks.afterReceiptCompleted?.(receipt.invocationId);
  cleanupCompletedReceipt(paths, complete, assertOwned);
  return complete;
}

export function cleanupCompletedReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
  assertOwned: () => void,
): void {
  if (receipt.state !== 'complete') throw receiptUnsafe();
  assertHostWrapperRetentionMarker(paths, receipt);
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  const stagingStats = fs.lstatSync(stagingDirectory, {
    throwIfNoEntry: false,
  });
  if (stagingStats) assertPrivateDirectory(stagingStats);
  for (const artifact of physicalArtifactsForReceipt(paths, receipt)) {
    if (fs.lstatSync(artifact.sourcePath, { throwIfNoEntry: false })) {
      throw runtimeUnsafe();
    }
    if (observeArtifact(artifact.stagingPath, artifact)) {
      assertOwned();
      fs.unlinkSync(artifact.stagingPath);
      fsyncDirectory(stagingDirectory);
    }
  }
  if (fs.lstatSync(stagingDirectory, { throwIfNoEntry: false })) {
    if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
    assertOwned();
    fs.rmdirSync(stagingDirectory);
    fsyncDirectory(path.dirname(stagingDirectory));
  }
  const runtimeDirectory = path.join(
    paths.invocations,
    receipt.invocationId,
    'runtime',
  );
  const runtimeStats = fs.lstatSync(runtimeDirectory, {
    throwIfNoEntry: false,
  });
  if (runtimeStats) {
    assertPrivateDirectory(runtimeStats);
    if (fs.readdirSync(runtimeDirectory).length !== 0) throw runtimeUnsafe();
    // Keep the empty, exact runtime directory as a non-authoritative physical
    // marker. If the external complete receipt disappears, the ordinary
    // scanner observes an incomplete runtime closure and fails closed even for
    // terminal failure records that do not carry runtimeObservation.
  }
  const reviewRoot = path.join(
    paths.invocations,
    receipt.invocationId,
    'review-root',
  );
  const reviewStats = fs.lstatSync(reviewRoot, { throwIfNoEntry: false });
  if (reviewStats) {
    assertPrivateDirectory(reviewStats);
    if (fs.readdirSync(reviewRoot).length !== 0) throw runtimeUnsafe();
  }
}

function ensureHostWrapperRetentionMarker(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
  assertOwned: () => void,
): void {
  if (!receiptHasHostWrapperArtifacts(receipt)) return;
  const invocationDirectory = path.join(
    paths.invocations,
    receipt.invocationId,
  );
  const probeDirectory = path.join(
    invocationDirectory,
    HOST_WRAPPER_PROBE_DIRECTORY,
  );
  const turnDirectory = path.join(
    invocationDirectory,
    HOST_WRAPPER_TURN_DIRECTORY,
  );
  assertEmptyPrivateDirectory(paths, probeDirectory);
  if (!fs.lstatSync(turnDirectory, { throwIfNoEntry: false })) {
    assertOwned();
    ensurePrivateDirectory(turnDirectory);
  }
  assertEmptyPrivateDirectory(paths, turnDirectory);
}

function assertHostWrapperRetentionMarker(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
): void {
  if (!receiptHasHostWrapperArtifacts(receipt)) return;
  const invocationDirectory = path.join(
    paths.invocations,
    receipt.invocationId,
  );
  assertEmptyPrivateDirectory(
    paths,
    path.join(invocationDirectory, HOST_WRAPPER_PROBE_DIRECTORY),
  );
  assertEmptyPrivateDirectory(
    paths,
    path.join(invocationDirectory, HOST_WRAPPER_TURN_DIRECTORY),
  );
}

function assertEmptyPrivateDirectory(
  paths: InvestigationRuntimePaths,
  directory: string,
): void {
  assertPrivateInvestigationDirectory(paths, directory, runtimeUnsafe);
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) throw runtimeUnsafe();
  assertPrivateDirectory(stats);
  if (
    fs.realpathSync(directory) !== path.resolve(directory) ||
    fs.readdirSync(directory).length !== 0
  ) {
    throw runtimeUnsafe();
  }
}

function receiptHasHostWrapperArtifacts(
  receipt: ProviderRetentionReceipt,
): boolean {
  return receipt.artifacts.some(({ name }) =>
    PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.includes(
      name as (typeof PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS)[number],
    ),
  );
}

export function recoverInterruptedPruning(
  paths: InvestigationRuntimePaths,
  now: Date,
  assertOwned: () => void,
  hooks: ProviderRetentionHooks,
): string | null {
  const stagingRoot = providerRetentionRoot(paths).staging;
  const entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  if (entries.length === 0) return null;
  if (
    entries.length !== 1 ||
    !entries[0]!.isDirectory() ||
    entries[0]!.isSymbolicLink() ||
    !/^[0-9a-f]{64}$/.test(entries[0]!.name)
  ) {
    throw runtimeUnsafe();
  }
  const stagingDirectory = path.join(stagingRoot, entries[0]!.name);
  assertPrivateDirectory(fs.lstatSync(stagingDirectory));
  if (fs.realpathSync(stagingDirectory) !== path.resolve(stagingDirectory)) {
    throw runtimeUnsafe();
  }
  const invocationId = readProviderRetentionCatalogEntry(
    paths,
    entries[0]!.name,
  ).invocationId;
  const receipt = readProviderRetentionReceipt(paths, invocationId);
  if (receipt === null) {
    if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
    assertOwned();
    fs.rmdirSync(stagingDirectory);
    fsyncDirectory(stagingRoot);
    return invocationId;
  }
  const detachedPreparedReceipt = receipt.state === 'prepared';
  if (detachedPreparedReceipt) {
    restorePreparedArtifactsAndDetachReceipt(paths, receipt, assertOwned);
  }
  try {
    const record = readProviderInvocation(paths, invocationId);
    const binding = readInvocationBinding(paths, record);
    assertReceiptBinding(receipt, binding, record);
  } catch (error) {
    if (detachedPreparedReceipt) {
      assertOwned();
      createPrivateFileAtomic(
        providerRetentionReceiptPath(paths, receipt.invocationId),
        canonicalProviderRetentionReceipt(receipt),
      );
    }
    throw error;
  }
  if (receipt.state === 'prepared') {
    assertOwned();
    createPrivateFileAtomic(
      providerRetentionReceiptPath(paths, receipt.invocationId),
      canonicalProviderRetentionReceipt(receipt),
    );
    completePreparedReceipt(paths, receipt, now, assertOwned, hooks);
  } else {
    cleanupCompletedReceipt(paths, receipt, assertOwned);
  }
  return invocationId;
}

function restorePreparedArtifactsAndDetachReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
  assertOwned: () => void,
): void {
  if (receipt.state !== 'prepared') throw receiptUnsafe();
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  for (const artifact of physicalArtifactsForReceipt(paths, receipt)) {
    const source = observeArtifact(artifact.sourcePath, artifact);
    const staged = observeArtifact(artifact.stagingPath, artifact);
    if (source && staged) throw runtimeUnsafe();
    if (!source && !staged) {
      throw workflowError(
        'PROVIDER_RETENTION_PRUNING_PARTIAL',
        'Prepared provider pruning lost an artifact before receipt recovery.',
        ExitCode.staleState,
      );
    }
    if (staged) {
      assertOwned();
      fs.renameSync(artifact.stagingPath, artifact.sourcePath);
      fsyncDirectory(stagingDirectory);
      fsyncDirectory(path.dirname(artifact.sourcePath));
      if (!observeArtifact(artifact.sourcePath, artifact)) {
        throw runtimeUnsafe();
      }
    }
  }
  if (fs.readdirSync(stagingDirectory).length !== 0) throw runtimeUnsafe();
  assertOwned();
  const receiptPath = providerRetentionReceiptPath(paths, receipt.invocationId);
  fs.unlinkSync(receiptPath);
  fsyncDirectory(path.dirname(receiptPath));
}
