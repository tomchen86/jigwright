/**
 * Binds provider retries and invocation projections to investigation resolution state.
 *
 * Invariants:
 * - Retry reservations bind the exact session, generation, policy snapshot, and replacement.
 * - Pending and terminal invocation observations retain their original ambiguity checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  type ProviderInvocationRequest,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { assertInvocationId } from '../../foundation/repository-path/repository-path.ts';
import { type InvestigationResolutionStateEnvelope } from '../../modules/investigation/domain/human-resolution-contract.ts';
import {
  assertPrivateInvestigationDirectory,
  MAX_HUMAN_RESOLUTION_BYTES,
  readPrivateCanonicalJson,
  readPrivateFile,
  walkPrivateDirectory,
} from './investigation-private-files.ts';
import { observeUnsafePath } from './investigation-resolution-values.ts';
import { type InvestigationSession } from '../../modules/investigation/domain/investigation-session-types.ts';
import {
  hasExactKeys,
  isDigest,
  isRecord,
  isTimestamp,
  providerInvocationUnsafe,
  sha256,
} from '../../modules/investigation/domain/investigation-store-values.ts';
import {
  isDurablyReservedProviderExecutionPolicySnapshot,
  scanProviderInvocationLifecycles,
} from './provider-invocation-lifecycle.ts';
import {
  assertProviderExecutionPolicySnapshot,
  type ProviderInvocationLifecycleProjection,
} from './provider-runtime-evidence-contract.ts';
import { digestPrivateDirectoryEntries } from './provider-runtime-retention.ts';

export type BoundProviderRetryReservation = {
  attempt: number;
  previousInvocationId: string;
  invocationId: string;
  requestDigest: string;
  manifestDigest: string;
  nonce: string;
  request: ProviderInvocationRequest;
  executionPolicySnapshot: Record<string, unknown>;
  reservationDigest: string;
  status: 'committed' | 'pending';
};

export function bindProviderRetryReservationResolutionState(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  makeError: () => WorkflowError,
): {
  reservations: InvestigationResolutionStateEnvelope['providerRetryReservations'];
  bindings: BoundProviderRetryReservation[];
} {
  assertPrivateInvestigationDirectory(paths, paths.refs, makeError);
  const prefix = `${session.investigationId}.provider-retry-`;
  const byAttempt = new Map<number, BoundProviderRetryReservation>();
  for (const name of fs.readdirSync(paths.refs).sort()) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    const match = /^([0-9]+)\.json$/.exec(suffix);
    if (!match) {
      throw makeError();
    }
    const attempt = Number(match[1]);
    if (
      !Number.isSafeInteger(attempt) ||
      attempt < 2 ||
      String(attempt) !== match[1] ||
      byAttempt.has(attempt)
    ) {
      throw makeError();
    }
    const status =
      attempt <= session.blindInvocationIds.length
        ? ('committed' as const)
        : ('pending' as const);
    if (attempt > session.blindInvocationIds.length + 1) {
      throw makeError();
    }
    byAttempt.set(
      attempt,
      readBoundProviderRetryReservation(
        paths,
        path.join(paths.refs, name),
        session,
        attempt,
        status,
        makeError,
      ),
    );
  }
  for (
    let attempt = 2;
    attempt <= session.blindInvocationIds.length;
    attempt += 1
  ) {
    if (!byAttempt.has(attempt)) {
      throw makeError();
    }
  }
  const bindings = [...byAttempt.values()].sort(
    (left, right) => left.attempt - right.attempt,
  );
  return {
    reservations: bindings.map(
      ({
        attempt,
        previousInvocationId,
        invocationId,
        reservationDigest,
        status,
      }) => ({
        attempt,
        previousInvocationId,
        invocationId,
        reservationDigest,
        status,
      }),
    ),
    bindings,
  };
}

function readBoundProviderRetryReservation(
  paths: InvestigationRuntimePaths,
  filePath: string,
  session: InvestigationSession,
  expectedAttempt: number,
  status: BoundProviderRetryReservation['status'],
  makeError: () => WorkflowError,
): BoundProviderRetryReservation {
  walkPrivateDirectory(paths, path.dirname(filePath), makeError, false);
  const content = readPrivateFile(filePath, makeError);
  if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
    throw makeError();
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  if (
    content !== `${canonicalJson(value)}\n` ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'attempt',
      'previousInvocationId',
      'invocationId',
      'manifestDigest',
      'requestDigest',
      'request',
      'createdAt',
      'executionPolicySnapshot',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'retryDecision',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-retry-reservation' ||
    value.investigationId !== session.investigationId ||
    value.changeId !== session.changeId ||
    canonicalJson(value.mandateBinding ?? null) !==
      canonicalJson(session.mandateBinding ?? null) ||
    value.attempt !== expectedAttempt ||
    typeof value.previousInvocationId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw makeError();
  }
  let previousInvocationId: string;
  let invocationId: string;
  try {
    previousInvocationId = assertInvocationId(value.previousInvocationId);
    invocationId = assertInvocationId(value.invocationId);
  } catch {
    throw makeError();
  }
  const expectedPrevious =
    session.blindInvocationIds[expectedAttempt - 2] ?? null;
  const expectedCommitted =
    status === 'committed'
      ? (session.blindInvocationIds[expectedAttempt - 1] ?? null)
      : null;
  if (
    expectedPrevious === null ||
    previousInvocationId !== expectedPrevious ||
    (status === 'committed' && invocationId !== expectedCommitted) ||
    (status === 'pending' &&
      session.blindInvocationIds.includes(invocationId)) ||
    invocationId === previousInvocationId ||
    value.manifestDigest !== session.blindManifestDigest
  ) {
    throw makeError();
  }
  let request: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(value.request);
  } catch {
    throw makeError();
  }
  if (
    request.invocationId !== invocationId ||
    request.requestDigest !== value.requestDigest ||
    request.purpose !== 'survey' ||
    request.inputManifestDigest !== value.manifestDigest ||
    request.baseCommit !== session.baseline.head ||
    request.baseTree !== session.baseline.tree
  ) {
    throw makeError();
  }
  if (
    !isRecord(value.executionPolicySnapshot) ||
    !isRecord(value.retryDecision)
  ) {
    throw makeError();
  }
  try {
    assertProviderExecutionPolicySnapshot(
      paths,
      value.executionPolicySnapshot,
      request,
    );
  } catch {
    throw makeError();
  }
  return {
    attempt: expectedAttempt,
    previousInvocationId,
    invocationId,
    requestDigest: request.requestDigest,
    manifestDigest: value.manifestDigest,
    nonce: request.nonce,
    request,
    executionPolicySnapshot: value.executionPolicySnapshot,
    reservationDigest: sha256(content),
    status,
  };
}

export function observeProviderRetryReservationAmbiguities(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  observations: Array<{
    object: string;
    observationDigest: string;
  }>,
): void {
  const prefix = `${session.investigationId}.provider-retry-`;
  let names: string[];
  try {
    assertPrivateInvestigationDirectory(
      paths,
      paths.refs,
      providerInvocationUnsafe,
    );
    names = fs
      .readdirSync(paths.refs)
      .filter((name) => name.startsWith(prefix));
  } catch {
    observeUnsafePath(
      paths.refs,
      `provider-retry-reservations:${session.investigationId}`,
      observations,
    );
    return;
  }
  const targets = new Set<string>(
    names.map((name) => path.join(paths.refs, name)),
  );
  for (
    let attempt = 2;
    attempt <= session.blindInvocationIds.length;
    attempt += 1
  ) {
    targets.add(path.join(paths.refs, `${prefix}${attempt}.json`));
  }
  for (const target of [...targets].sort()) {
    observeUnsafePath(
      target,
      `provider-retry-reservation:${path.basename(target)}`,
      observations,
    );
  }
}

export function bindProviderInvocationResolutionState(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  retryBindings: BoundProviderRetryReservation[],
): Pick<
  InvestigationResolutionStateEnvelope,
  'providerInvocationDigests' | 'repositoryProviderLeases'
> {
  const scan = scanProviderInvocationLifecycles(paths);
  const projections = [...scan.projections];
  const pendingRetry =
    retryBindings.find(({ status }) => status === 'pending') ?? null;
  const allowedReservedSnapshotIds = new Set<string>();
  for (const { invocationId } of scan.unsafeInvocations) {
    if (pendingRetry?.invocationId === invocationId) {
      assertPendingProviderExecutionPolicySnapshot(paths, pendingRetry);
      allowedReservedSnapshotIds.add(invocationId);
    } else if (
      isDurablyReservedProviderExecutionPolicySnapshot(paths, invocationId)
    ) {
      allowedReservedSnapshotIds.add(invocationId);
    }
  }
  const unsafeInvocations = scan.unsafeInvocations.filter(
    ({ invocationId }) => !allowedReservedSnapshotIds.has(invocationId),
  );
  const target = projections.filter(
    (projection) =>
      projection.ownerInvestigationId === session.investigationId &&
      projection.changeId === session.changeId,
  );
  if (
    unsafeInvocations.some(
      ({ invocationId, ownerInvestigationId }) =>
        ownerInvestigationId === session.investigationId ||
        invocationId === pendingRetry?.invocationId,
    )
  ) {
    throw providerInvocationUnsafe();
  }
  const globalPendingProjection =
    pendingRetry === null
      ? undefined
      : projections.find(
          ({ invocationId }) => invocationId === pendingRetry.invocationId,
        );
  if (
    globalPendingProjection !== undefined &&
    (globalPendingProjection.ownerInvestigationId !== session.investigationId ||
      globalPendingProjection.changeId !== session.changeId ||
      globalPendingProjection.purpose !== 'survey')
  ) {
    throw providerInvocationUnsafe();
  }
  const targetSurveys = target.filter(
    (projection) => projection.purpose === 'survey',
  );
  const targetSurveyIds = targetSurveys
    .map((projection) => projection.invocationId)
    .sort();
  const expectedSurveyIds = [...session.blindInvocationIds];
  if (
    pendingRetry !== null &&
    targetSurveyIds.includes(pendingRetry.invocationId)
  ) {
    expectedSurveyIds.push(pendingRetry.invocationId);
  }
  if (
    canonicalJson(targetSurveyIds) !== canonicalJson(expectedSurveyIds.sort())
  ) {
    throw providerInvocationUnsafe();
  }
  const boundNonces = session.blindInvocationIds.map((invocationId) => {
    const projection = targetSurveys.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    if (projection === undefined) {
      throw providerInvocationUnsafe();
    }
    return projection.nonce;
  });
  if (pendingRetry !== null) {
    boundNonces.push(pendingRetry.nonce);
  }
  if (new Set(boundNonces).size !== boundNonces.length) {
    throw providerInvocationUnsafe();
  }
  const retryByAttempt = new Map(
    retryBindings.map((binding) => [binding.attempt, binding]),
  );
  for (const [index, invocationId] of session.blindInvocationIds.entries()) {
    const attempt = index + 1;
    const projection = targetSurveys.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    if (
      projection === undefined ||
      projection.attempt !== attempt ||
      projection.manifestDigest !== session.blindManifestDigest
    ) {
      throw providerInvocationUnsafe();
    }
    if (attempt === 1) {
      continue;
    }
    const retry = retryByAttempt.get(attempt);
    const previous = targetSurveys.find(
      (candidate) =>
        candidate.invocationId === session.blindInvocationIds[index - 1],
    );
    if (
      retry === undefined ||
      retry.status !== 'committed' ||
      retry.invocationId !== projection.invocationId ||
      retry.requestDigest !== projection.requestDigest ||
      retry.manifestDigest !== projection.manifestDigest ||
      previous?.state !== 'failed' ||
      previous.failureKind !== 'retryable'
    ) {
      throw providerInvocationUnsafe();
    }
  }
  if (pendingRetry !== null) {
    const previous = targetSurveys.find(
      (candidate) =>
        candidate.invocationId === pendingRetry.previousInvocationId,
    );
    const pendingProjection = targetSurveys.find(
      (candidate) => candidate.invocationId === pendingRetry.invocationId,
    );
    if (
      previous?.state !== 'failed' ||
      previous.failureKind !== 'retryable' ||
      (pendingProjection !== undefined &&
        (pendingProjection.attempt !== pendingRetry.attempt ||
          pendingProjection.requestDigest !== pendingRetry.requestDigest ||
          pendingProjection.manifestDigest !== pendingRetry.manifestDigest))
    ) {
      throw providerInvocationUnsafe();
    }
  }
  return {
    providerInvocationDigests: [
      ...target.map(({ invocationId }) => ({
        invocationId,
        files: digestPrivateDirectoryEntries(
          paths,
          path.join(paths.invocations, invocationId),
          providerInvocationUnsafe,
        ),
      })),
      ...unsafeInvocations.map(({ invocationId, observationDigest }) => ({
        invocationId,
        files: [{ name: 'unsafe-observation', digest: observationDigest }],
      })),
    ].sort((left, right) =>
      left.invocationId.localeCompare(right.invocationId),
    ),
    repositoryProviderLeases: projections
      .filter(
        (
          projection,
        ): projection is ProviderInvocationLifecycleProjection & {
          lease: NonNullable<ProviderInvocationLifecycleProjection['lease']>;
        } => projection.state === 'leased' && projection.lease !== null,
      )
      .map((projection) => ({
        invocationId: projection.invocationId,
        investigationId: projection.ownerInvestigationId,
        changeId: projection.changeId,
        revision: projection.revision,
        leaseGeneration: projection.leaseGeneration,
        leaseDigest: sha256(canonicalJson(projection.lease)),
      })),
  };
}

function assertPendingProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  pending: BoundProviderRetryReservation,
): string | null {
  const directory = path.join(paths.invocations, pending.invocationId);
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) {
    return null;
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !walkPrivateDirectory(paths, directory, providerInvocationUnsafe, false) ||
    canonicalJson(fs.readdirSync(directory).sort()) !==
      canonicalJson(['execution-policy.json'])
  ) {
    throw providerInvocationUnsafe();
  }
  const snapshot = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'execution-policy.json'),
    providerInvocationUnsafe,
  );
  assertProviderExecutionPolicySnapshot(paths, snapshot, pending.request);
  if (
    canonicalJson(snapshot) !== canonicalJson(pending.executionPolicySnapshot)
  ) {
    throw providerInvocationUnsafe();
  }
  return pending.invocationId;
}
