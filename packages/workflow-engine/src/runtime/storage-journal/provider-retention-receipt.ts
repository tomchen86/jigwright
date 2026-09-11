/**
 * Creates and validates retention receipts and their retained artifact
 * evidence.
 *
 * Invariants:
 * - Receipt reads reject file identity or size changes observed during the
 *   read.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertInvocationId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const NORMALIZED_DIGEST = /^sha256:[0-9a-f]{64}$/;

export const PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS = [
  'host-wrapper-probe-runtime/request.json',
  'host-wrapper-probe-runtime/probe-result.json',
  'host-wrapper-runtime/request.json',
  'host-wrapper-runtime/semantic-output.json',
] as const;

export type ProviderRetentionArtifactName =
  | 'completion-candidate'
  | 'review-root'
  | 'runtime/prompt.json'
  | 'runtime/schema.json'
  | 'runtime/semantic-output.json'
  | (typeof PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS)[number];

const RETENTION_ARTIFACTS = new Set<ProviderRetentionArtifactName>([
  'completion-candidate',
  ...PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS,
  'review-root',
  'runtime/prompt.json',
  'runtime/schema.json',
  'runtime/semantic-output.json',
]);

export const PROVIDER_RETENTION_MAX_RECEIPT_BYTES = 4_096;

export type ProviderRetentionArtifact = Readonly<{
  name: ProviderRetentionArtifactName;
  digest: string;
  bytes: number;
}>;

export type ProviderRetentionReviewRootLeaf = Readonly<{
  name: string;
  digest: string;
  bytes: number;
}>;

export type ProviderRetentionReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-runtime-prune-receipt';
  state: 'prepared' | 'complete';
  receiptId: string;
  invocationId: string;
  workflowId: string;
  jobId: string;
  attemptId: string;
  contextDigest: string;
  executionRevision: number;
  executionStateDigest: string;
  epoch: number;
  currentEpoch: number;
  attemptRetention: 'active' | 'debug' | 'pinned';
  acceptedAttemptId: string | null;
  requestDigest: string;
  manifestDigest: string;
  invocationRevision: number;
  terminalState: 'succeeded' | 'failed';
  terminalAt: string;
  ttlDays: number;
  cutoffAt: string;
  artifacts: ProviderRetentionArtifact[];
  preparedAt: string;
  completedAt: string | null;
  receiptDigest: string;
}>;

export type ProviderRetentionReceiptBinding = Readonly<{
  requestDigest: string;
  manifestDigest: string;
  invocationRevision: number;
  terminalState: 'succeeded' | 'failed';
  terminalAt: string;
}>;

export function providerRetentionRoot(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'provider-retention');
  return {
    root,
    receipts: path.join(root, 'receipts'),
    staging: path.join(root, 'staging'),
  };
}

export function providerRetentionReceiptPath(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): string {
  const invocationId = assertInvocationId(requestedInvocationId);
  return path.join(
    providerRetentionRoot(paths).receipts,
    `${sha256(invocationId)}.json`,
  );
}

export function providerRetentionStagingDirectory(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): string {
  const invocationId = assertInvocationId(requestedInvocationId);
  return path.join(providerRetentionRoot(paths).staging, sha256(invocationId));
}

export function createProviderRetentionReceipt(
  input: Omit<ProviderRetentionReceipt, 'receiptDigest'>,
): ProviderRetentionReceipt {
  const receipt = {
    ...input,
    receiptDigest: sha256(canonicalJson(input)),
  };
  return assertProviderRetentionReceipt(receipt);
}

export function providerRetentionReceiptId(
  input: Pick<
    ProviderRetentionReceipt,
    | 'invocationId'
    | 'workflowId'
    | 'jobId'
    | 'attemptId'
    | 'contextDigest'
    | 'epoch'
    | 'currentEpoch'
    | 'requestDigest'
    | 'manifestDigest'
    | 'invocationRevision'
    | 'terminalAt'
    | 'artifacts'
    | 'executionRevision'
    | 'executionStateDigest'
    | 'attemptRetention'
    | 'acceptedAttemptId'
  >,
): string {
  return sha256(
    canonicalJson({
      invocationId: input.invocationId,
      workflowId: input.workflowId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      contextDigest: input.contextDigest,
      epoch: input.epoch,
      currentEpoch: input.currentEpoch,
      requestDigest: input.requestDigest,
      manifestDigest: input.manifestDigest,
      invocationRevision: input.invocationRevision,
      terminalAt: input.terminalAt,
      artifacts: input.artifacts,
      executionRevision: input.executionRevision,
      executionStateDigest: input.executionStateDigest,
      attemptRetention: input.attemptRetention,
      acceptedAttemptId: input.acceptedAttemptId,
    }),
  );
}

export function canonicalProviderRetentionReceipt(
  receipt: ProviderRetentionReceipt,
): string {
  return `${canonicalJson(assertProviderRetentionReceipt(receipt))}\n`;
}

export function readProviderRetentionReceipt(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderRetentionReceipt | null {
  const invocationId = assertInvocationId(requestedInvocationId);
  if (!assertRetentionDirectories(paths, false)) return null;
  const receiptPath = providerRetentionReceiptPath(paths, invocationId);
  const stats = fs.lstatSync(receiptPath, { throwIfNoEntry: false });
  if (!stats) return null;
  assertPrivateRegularFile(stats);
  let raw: string;
  try {
    const descriptor = fs.openSync(
      receiptPath,
      fs.constants.O_RDONLY |
        (process.platform === 'win32'
          ? 0
          : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      assertPrivateRegularFile(opened);
      if (
        !sameStableFile(stats, opened) ||
        opened.size >= PROVIDER_RETENTION_MAX_RECEIPT_BYTES
      ) {
        throw receiptUnsafe();
      }
      const expectedBytes = opened.size;
      const buffer = Buffer.alloc(expectedBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(
          descriptor,
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (count === 0) break;
        offset += count;
      }
      const afterOpened = fs.fstatSync(descriptor);
      const afterPath = fs.lstatSync(receiptPath, { throwIfNoEntry: false });
      if (
        offset !== expectedBytes ||
        !afterPath ||
        !sameStableFile(opened, afterOpened) ||
        !sameStableFile(opened, afterPath)
      ) {
        throw receiptUnsafe();
      }
      assertRetentionDirectories(paths, true);
      if (fs.realpathSync(receiptPath) !== path.resolve(receiptPath)) {
        throw receiptUnsafe();
      }
      raw = buffer.subarray(0, offset).toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (isRetentionReceiptError(error)) throw error;
    throw receiptUnsafe();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw receiptUnsafe();
  }
  const receipt = assertProviderRetentionReceipt(value);
  if (
    receipt.invocationId !== invocationId ||
    canonicalProviderRetentionReceipt(receipt) !== raw ||
    path.basename(receiptPath) !== `${sha256(receipt.invocationId)}.json`
  ) {
    throw receiptUnsafe();
  }
  return receipt;
}

export function readCompleteProviderRetentionReceipt(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
  binding: ProviderRetentionReceiptBinding,
): ProviderRetentionReceipt | null {
  const receipt = readProviderRetentionReceipt(paths, requestedInvocationId);
  if (receipt === null) return null;
  if (receipt.state !== 'complete' || receipt.completedAt === null) {
    throw workflowError(
      'PROVIDER_RETENTION_PRUNING_PARTIAL',
      'Provider runtime pruning is incomplete and requires recovery.',
      ExitCode.staleState,
    );
  }
  if (
    receipt.requestDigest !== binding.requestDigest ||
    receipt.manifestDigest !== binding.manifestDigest ||
    receipt.invocationRevision !== binding.invocationRevision ||
    receipt.terminalState !== binding.terminalState ||
    receipt.terminalAt !== binding.terminalAt
  ) {
    throw receiptUnsafe();
  }
  return receipt;
}

export function providerRetentionArtifact(
  receipt: ProviderRetentionReceipt,
  name: ProviderRetentionArtifactName,
): ProviderRetentionArtifact | null {
  return receipt.artifacts.find((artifact) => artifact.name === name) ?? null;
}

export function providerRetentionReviewRootArtifact(
  leaves: readonly ProviderRetentionReviewRootLeaf[],
): ProviderRetentionArtifact {
  if (
    leaves.length < 1 ||
    leaves.length > 4_096 ||
    leaves.some(
      (leaf, index) =>
        leaf.name !==
          `review-root/${String(index).padStart(4, '0')}.artifact` ||
        !isDigest(leaf.digest) ||
        !isNonNegativeInteger(leaf.bytes),
    )
  ) {
    throw receiptUnsafe();
  }
  const bytes = leaves.reduce((sum, leaf) => sum + leaf.bytes, 0);
  if (!Number.isSafeInteger(bytes)) throw receiptUnsafe();
  return {
    name: 'review-root',
    digest: sha256(canonicalJson(leaves)),
    bytes,
  };
}

function assertProviderRetentionReceipt(
  value: unknown,
): ProviderRetentionReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifacts',
      'acceptedAttemptId',
      'attemptId',
      'attemptRetention',
      'completedAt',
      'contextDigest',
      'currentEpoch',
      'cutoffAt',
      'epoch',
      'executionRevision',
      'executionStateDigest',
      'invocationId',
      'jobId',
      'kind',
      'invocationRevision',
      'manifestDigest',
      'preparedAt',
      'receiptDigest',
      'receiptId',
      'requestDigest',
      'schemaVersion',
      'state',
      'terminalAt',
      'terminalState',
      'ttlDays',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-runtime-prune-receipt' ||
    (value.state !== 'prepared' && value.state !== 'complete') ||
    !isDigest(value.receiptId) ||
    typeof value.invocationId !== 'string' ||
    typeof value.workflowId !== 'string' ||
    typeof value.jobId !== 'string' ||
    typeof value.attemptId !== 'string' ||
    !isNormalizedDigest(value.contextDigest) ||
    !isNonNegativeInteger(value.executionRevision) ||
    !isDigest(value.executionStateDigest) ||
    !isPositiveInteger(value.epoch) ||
    !isPositiveInteger(value.currentEpoch) ||
    !['active', 'debug', 'pinned'].includes(String(value.attemptRetention)) ||
    (value.acceptedAttemptId !== null &&
      typeof value.acceptedAttemptId !== 'string') ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.manifestDigest) ||
    !isNonNegativeInteger(value.invocationRevision) ||
    (value.terminalState !== 'succeeded' && value.terminalState !== 'failed') ||
    !isTimestamp(value.terminalAt) ||
    !isPositiveInteger(value.ttlDays) ||
    !isTimestamp(value.cutoffAt) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > RETENTION_ARTIFACTS.size ||
    !isTimestamp(value.preparedAt) ||
    !isDigest(value.receiptDigest) ||
    (value.state === 'prepared' && value.completedAt !== null) ||
    (value.state === 'complete' && !isTimestamp(value.completedAt))
  ) {
    throw receiptUnsafe();
  }
  assertInvocationId(value.invocationId);
  const artifacts = value.artifacts.map(assertArtifact);
  const names = artifacts.map(({ name }) => name);
  if (
    new Set(names).size !== names.length ||
    canonicalJson(names) !== canonicalJson([...names].sort()) ||
    !isValidHostWrapperArtifactPhase(
      names,
      value.terminalState as 'succeeded' | 'failed',
    )
  ) {
    throw receiptUnsafe();
  }
  if (
    value.receiptId !==
    providerRetentionReceiptId({
      invocationId: value.invocationId,
      workflowId: value.workflowId,
      jobId: value.jobId,
      attemptId: value.attemptId,
      contextDigest: value.contextDigest,
      epoch: value.epoch as number,
      currentEpoch: value.currentEpoch as number,
      requestDigest: value.requestDigest,
      manifestDigest: value.manifestDigest,
      invocationRevision: value.invocationRevision as number,
      terminalAt: value.terminalAt,
      artifacts,
      executionRevision: value.executionRevision as number,
      executionStateDigest: value.executionStateDigest,
      attemptRetention: value.attemptRetention as 'active' | 'debug' | 'pinned',
      acceptedAttemptId:
        value.acceptedAttemptId === null ? null : value.acceptedAttemptId,
    })
  ) {
    throw receiptUnsafe();
  }
  const payload = { ...value };
  delete payload.receiptDigest;
  if (sha256(canonicalJson(payload)) !== value.receiptDigest) {
    throw receiptUnsafe();
  }
  return deepFreeze({
    ...(value as Omit<ProviderRetentionReceipt, 'artifacts'>),
    artifacts,
  });
}

function isValidHostWrapperArtifactPhase(
  names: readonly ProviderRetentionArtifactName[],
  terminalState: 'succeeded' | 'failed',
): boolean {
  const observed = new Set(
    names.filter((name) =>
      PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.includes(
        name as (typeof PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS)[number],
      ),
    ),
  );
  if (observed.size === 0) return true;
  if (
    terminalState === 'succeeded' &&
    observed.size !== PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.length
  ) {
    return false;
  }
  const expected = new Set(
    PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.slice(0, observed.size),
  );
  return (
    expected.size === observed.size &&
    [...expected].every((name) => observed.has(name))
  );
}

function assertArtifact(value: unknown): ProviderRetentionArtifact {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['bytes', 'digest', 'name']) ||
    typeof value.name !== 'string' ||
    !RETENTION_ARTIFACTS.has(value.name as ProviderRetentionArtifactName) ||
    !isDigest(value.digest) ||
    !isNonNegativeInteger(value.bytes)
  ) {
    throw receiptUnsafe();
  }
  return {
    name: value.name as ProviderRetentionArtifactName,
    digest: value.digest,
    bytes: value.bytes as number,
  };
}

function assertPrivateRegularFile(stats: fs.Stats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600)
  ) {
    throw receiptUnsafe();
  }
}

export function assertRetentionDirectories(
  paths: InvestigationRuntimePaths,
  required: boolean,
): boolean {
  const resolvedRoot = path.resolve(paths.root);
  const relative = path.relative(paths.base, resolvedRoot);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw receiptUnsafe();
  }
  const investigationRoot = fs.lstatSync(resolvedRoot, {
    throwIfNoEntry: false,
  });
  if (!investigationRoot) {
    if (required) throw receiptUnsafe();
    return false;
  }
  if (
    !investigationRoot.isDirectory() ||
    investigationRoot.isSymbolicLink() ||
    fs.realpathSync(resolvedRoot) !== resolvedRoot
  ) {
    throw receiptUnsafe();
  }
  const retention = providerRetentionRoot(paths);
  const rootStats = fs.lstatSync(retention.root, { throwIfNoEntry: false });
  if (!rootStats) {
    if (required) throw receiptUnsafe();
    return false;
  }
  for (const directory of [
    retention.root,
    retention.receipts,
    retention.staging,
  ]) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats) {
      if (required) throw receiptUnsafe();
      return false;
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory) ||
      (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700)
    ) {
      throw receiptUnsafe();
    }
  }
  return true;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isRetentionReceiptError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('PROVIDER_RETENTION_')
  );
}

function receiptUnsafe() {
  return workflowError(
    'PROVIDER_RETENTION_RECEIPT_UNSAFE',
    'Provider runtime pruning receipt is missing, malformed, or tampered.',
    ExitCode.unsafeEnvironment,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNormalizedDigest(value: unknown): value is string {
  return typeof value === 'string' && NORMALIZED_DIGEST.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
