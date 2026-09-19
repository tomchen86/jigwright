/**
 * Create, read, and retire exact investigation-start and provider-retry reservations.
 *
 * Invariants:
 * - Reservation locks, CAS checks, schemas, and canonical bytes retain their order.
 * - Retry policy and replacement bindings remain attached to the exact request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type LoadedAiAdapterPolicy } from '../provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  withPrivateRuntimeLock,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import { type ProviderExecutionGrantAuthorityInput } from './provider-execution-policy-authority.ts';
import { type ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
} from '../../foundation/repository-path/repository-path.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import type { BlindSurveyManifest } from '../../modules/investigation/manifest/blind-survey-manifest.ts';
import type {
  InvestigationStartReservation,
  InvestigationStartReservationSnapshot,
  ProviderRetryDecisionBinding,
  ProviderRetryReplacementBinding,
  ProviderRetryReservationCurrent,
} from '../../modules/provider-orchestration/provider-invocation-reservations.ts';
import type { ProviderInvocationManifest } from './provider-invocation-manifest-validation.ts';
import type { ProviderExecutionPolicySnapshotCurrent } from '../../modules/provider-orchestration/provider-execution-policy-snapshot.ts';
import {
  assertBlindSurveyManifest,
  assertProviderRequest,
  blindSurveyManifestDigest,
  assertBlindInvocationBinding,
  assertProviderInvocationManifest,
  providerInvocationManifestDigest,
  assertProviderInvocationBinding,
} from './provider-invocation-validation.ts';
import {
  isTimestamp,
  invocationInvalid,
  investigationStartReservationPath,
  invocationUnsafe,
  startReservationLockInvalid,
  deepFreeze,
  absentInvestigationStartReservationSnapshot,
  sha256,
  DIGEST,
  startReservationCasMismatch,
  fsyncDirectory,
  providerRetryReservationPath,
  isRecord,
  hasExactKeys,
  isTaskMandateBinding,
  isBaseline,
  isDigest,
} from './provider-invocation-common.ts';
import {
  storeProviderExecutionPolicySnapshot,
  createProviderExecutionPolicySnapshot,
  ensureProviderExecutionPolicySnapshotFromSnapshot,
  validateProviderExecutionPolicySnapshot,
} from './provider-invocation-policy.ts';
import { readPrivateCanonicalDocument } from './provider-invocation-artifacts.ts';

export function createInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    investigationId: string;
    repositoryRoot: string;
    gitCommonDirectory: string;
    branch: string | null;
    baseline: {
      head: string;
      tree: string;
    };
    manifest: BlindSurveyManifest;
    request: ProviderInvocationRequest;
    executionPolicy: LoadedAiAdapterPolicy;
    mandateBinding?: TaskMandateBinding;
    createdAt?: string;
  },
): InvestigationStartReservation {
  const changeId = assertChangeId(input.changeId);
  const investigationId = assertInvestigationId(input.investigationId);
  const manifest = assertBlindSurveyManifest(input.manifest);
  const request = assertProviderRequest(input.request);
  const manifestDigest = blindSurveyManifestDigest(manifest);
  assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!isTimestamp(createdAt)) {
    throw invocationInvalid();
  }
  const reservation = assertInvestigationStartReservation({
    schemaVersion: 1,
    kind: 'investigation-start-reservation',
    changeId,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    investigationId,
    invocationId: request.invocationId,
    repositoryRoot: input.repositoryRoot,
    gitCommonDirectory: input.gitCommonDirectory,
    branch: input.branch,
    baseline: input.baseline,
    manifestDigest,
    requestDigest: request.requestDigest,
    manifest,
    request,
    createdAt,
  });
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.investigation-start.lock`),
    () => {
      storeProviderExecutionPolicySnapshot(
        paths,
        request,
        input.executionPolicy,
      );
      createPrivateCanonicalJson(
        paths,
        investigationStartReservationPath(paths, changeId),
        reservation,
        invocationUnsafe,
        'INVESTIGATION_START_RESERVATION_CONFLICT',
      );
      return readInvestigationStartReservation(
        paths,
        changeId,
      ) as InvestigationStartReservation;
    },
    'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT',
    startReservationLockInvalid,
  );
}

export function readInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): InvestigationStartReservation | null {
  const changeId = assertChangeId(requestedChangeId);
  const reservationPath = investigationStartReservationPath(paths, changeId);
  if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
    return null;
  }
  const reservation = assertInvestigationStartReservation(
    readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe),
  );
  if (reservation.changeId !== changeId) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(reservation));
}

export function readInvestigationStartReservationSnapshot(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): InvestigationStartReservationSnapshot {
  const changeId = assertChangeId(requestedChangeId);
  const reservationPath = investigationStartReservationPath(paths, changeId);
  if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
    return absentInvestigationStartReservationSnapshot();
  }
  const rawDocument = readPrivateCanonicalDocument(
    paths,
    reservationPath,
    invocationUnsafe,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDocument);
  } catch {
    throw invocationInvalid();
  }
  const reservation = assertInvestigationStartReservation(parsed);
  if (
    reservation.changeId !== changeId ||
    rawDocument !== `${canonicalJson(parsed)}\n`
  ) {
    throw invocationInvalid();
  }
  return Object.freeze({
    rawDocument,
    digest: sha256(rawDocument),
    reservation,
  });
}

export function retireInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  input: {
    changeId: string;
    expectedDigest: string | null;
  },
): InvestigationStartReservationSnapshot {
  const changeId = assertChangeId(input.changeId);
  if (input.expectedDigest !== null && !DIGEST.test(input.expectedDigest)) {
    throw invocationInvalid();
  }
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.investigation-start.lock`),
    () => {
      const current = readInvestigationStartReservationSnapshot(
        paths,
        changeId,
      );
      if (current.digest === null) {
        return current;
      }
      if (current.digest !== input.expectedDigest) {
        throw startReservationCasMismatch(input.expectedDigest, current.digest);
      }
      fs.unlinkSync(investigationStartReservationPath(paths, changeId));
      fsyncDirectory(paths.refs);
      const retired = readInvestigationStartReservationSnapshot(
        paths,
        changeId,
      );
      if (retired.digest !== null) {
        throw invocationInvalid();
      }
      return retired;
    },
    'INVESTIGATION_START_RESERVATION_OPERATION_CONFLICT',
    startReservationLockInvalid,
  );
}

export function createProviderRetryReservation(
  paths: InvestigationRuntimePaths,
  input: {
    investigationId: string;
    changeId: string;
    attempt: number;
    previousInvocationId: string;
    manifest: ProviderInvocationManifest;
    request: ProviderInvocationRequest;
    executionPolicy: LoadedAiAdapterPolicy;
    executionGrantAuthorization?: ProviderExecutionGrantAuthorityInput;
    retryDecision?: ProviderRetryDecisionBinding;
    replacement?: ProviderRetryReplacementBinding;
    mandateBinding?: TaskMandateBinding;
    createdAt?: string;
  },
): ProviderRetryReservationCurrent {
  const investigationId = assertInvestigationId(input.investigationId);
  const changeId = assertChangeId(input.changeId);
  const previousInvocationId = assertInvocationId(input.previousInvocationId);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 2) {
    throw invocationInvalid();
  }
  const manifest = assertProviderInvocationManifest(input.manifest);
  const request = assertProviderRequest(input.request);
  if (input.retryDecision === undefined) {
    throw workflowError(
      'PROVIDER_RETRY_DECISION_EVIDENCE_REQUIRED',
      'A durable retry decision binding is required before reserving provider work.',
      ExitCode.guard,
    );
  }
  const retryDecision = assertProviderRetryDecisionBinding(input.retryDecision);
  const executionPolicySnapshot = createProviderExecutionPolicySnapshot(
    request,
    input.executionPolicy,
    input.executionGrantAuthorization,
  );
  const manifestDigest = providerInvocationManifestDigest(manifest);
  assertProviderInvocationBinding(changeId, manifest, manifestDigest, request);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const reservation = assertProviderRetryReservation({
    schemaVersion: input.replacement === undefined ? 2 : 3,
    kind: 'provider-retry-reservation',
    investigationId,
    changeId,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    attempt: input.attempt,
    previousInvocationId,
    invocationId: request.invocationId,
    manifestDigest,
    requestDigest: request.requestDigest,
    request,
    ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
    retryDecision,
    executionPolicySnapshot,
    ...(input.replacement === undefined
      ? {}
      : { replacement: input.replacement }),
    createdAt,
  });
  createPrivateCanonicalJson(
    paths,
    providerRetryReservationPath(paths, investigationId, input.attempt),
    reservation,
    invocationUnsafe,
    'PROVIDER_RETRY_RESERVATION_CONFLICT',
  );
  ensureProviderExecutionPolicySnapshotFromSnapshot(
    paths,
    request,
    executionPolicySnapshot,
  );
  return readProviderRetryReservation(
    paths,
    investigationId,
    input.attempt,
  ) as ProviderRetryReservationCurrent;
}

export function readProviderRetryReservation(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  attempt: number,
): ProviderRetryReservationCurrent | null {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  if (!Number.isSafeInteger(attempt) || attempt < 2) {
    throw invocationInvalid();
  }
  const reservationPath = providerRetryReservationPath(
    paths,
    investigationId,
    attempt,
  );
  if (!privatePathExists(paths, reservationPath, invocationUnsafe)) {
    return null;
  }
  const reservation = assertProviderRetryReservation(
    readPrivateCanonicalJson(paths, reservationPath, invocationUnsafe),
  );
  if (
    reservation.investigationId !== investigationId ||
    reservation.attempt !== attempt
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(reservation));
}

function assertInvestigationStartReservation(
  value: unknown,
): InvestigationStartReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'investigationId',
      'invocationId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'manifestDigest',
      'requestDigest',
      'manifest',
      'request',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-start-reservation' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    typeof value.investigationId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    typeof value.gitCommonDirectory !== 'string' ||
    !path.isAbsolute(value.gitCommonDirectory) ||
    (value.branch !== null &&
      (typeof value.branch !== 'string' || value.branch.length === 0)) ||
    !isBaseline(value.baseline) ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw invocationInvalid();
  }
  const changeId = assertChangeId(value.changeId);
  const investigationId = assertInvestigationId(value.investigationId);
  const invocationId = assertInvocationId(value.invocationId);
  const manifest = assertBlindSurveyManifest(value.manifest);
  const request = assertProviderRequest(value.request);
  const manifestDigest = blindSurveyManifestDigest(manifest);
  assertBlindInvocationBinding(changeId, manifest, manifestDigest, request);
  if (
    invocationId !== request.invocationId ||
    value.manifestDigest !== manifestDigest ||
    value.requestDigest !== request.requestDigest ||
    value.baseline.head !== manifest.baseCommit ||
    value.baseline.tree !== manifest.baseTree
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone({
      ...value,
      changeId,
      investigationId,
      invocationId,
      manifest,
      request,
    }),
  ) as InvestigationStartReservation;
}

function assertProviderRetryReservation(
  value: unknown,
): ProviderRetryReservationCurrent {
  const baseKeys = [
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
  ];
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
    !hasExactKeys(value, [
      ...baseKeys,
      'executionPolicySnapshot',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'retryDecision',
      ...(value.schemaVersion === 3 ? ['replacement'] : []),
    ]) ||
    value.kind !== 'provider-retry-reservation' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 2 ||
    typeof value.previousInvocationId !== 'string' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.requestDigest) ||
    !isTimestamp(value.createdAt)
  ) {
    throw invocationInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  assertInvocationId(value.previousInvocationId);
  const invocationId = assertInvocationId(value.invocationId);
  const request = assertProviderRequest(value.request);
  const retryDecision = assertProviderRetryDecisionBinding(value.retryDecision);
  const executionPolicySnapshot = assertEmbeddedProviderExecutionPolicySnapshot(
    value.executionPolicySnapshot,
    request,
  );
  const replacement =
    value.schemaVersion === 3
      ? assertProviderRetryReplacementBinding(value.replacement)
      : undefined;
  if (
    invocationId !== request.invocationId ||
    value.requestDigest !== request.requestDigest ||
    value.previousInvocationId === invocationId ||
    (replacement !== undefined &&
      (replacement.attemptId !== `attempt-provider-${invocationId}` ||
        request.authorizationNodeId !== replacement.authorizationNodeId))
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(
    structuredClone({
      ...value,
      invocationId,
      request,
      retryDecision,
      executionPolicySnapshot,
      ...(replacement === undefined ? {} : { replacement }),
    }),
  ) as ProviderRetryReservationCurrent;
}

function assertEmbeddedProviderExecutionPolicySnapshot(
  value: unknown,
  request: ProviderInvocationRequest,
): ProviderExecutionPolicySnapshotCurrent {
  try {
    return validateProviderExecutionPolicySnapshot(request, value);
  } catch {
    throw invocationInvalid();
  }
}

function assertProviderRetryDecisionBinding(
  value: unknown,
): ProviderRetryDecisionBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'evaluatedAt',
      'evidenceDigest',
      'executionJobId',
      'executionRevision',
      'failedAttemptId',
      'kind',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-retry-decision-binding' ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.executionJobId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    typeof value.failedAttemptId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value.failedAttemptId) ||
    typeof value.evidenceDigest !== 'string' ||
    !DIGEST.test(value.evidenceDigest) ||
    !isTimestamp(value.evaluatedAt)
  ) {
    throw invocationInvalid();
  }
  return deepFreeze(structuredClone(value) as ProviderRetryDecisionBinding);
}

function assertProviderRetryReplacementBinding(
  value: unknown,
): ProviderRetryReplacementBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attemptId',
      'retryMode',
      'strategyChanges',
      'environmentDigest',
      'executionGrantId',
      'authorizationNodeId',
      'reservationNodeId',
    ]) ||
    typeof value.attemptId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.attemptId) ||
    ![
      'same-input',
      'execution-policy-change',
      'repair',
      'strategy-change',
    ].includes(value.retryMode as string) ||
    !Array.isArray(value.strategyChanges) ||
    value.strategyChanges.length > 32 ||
    value.strategyChanges.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length < 1 ||
        Buffer.byteLength(entry, 'utf8') > 512,
    ) ||
    new Set(value.strategyChanges).size !== value.strategyChanges.length ||
    typeof value.environmentDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.environmentDigest) ||
    (value.executionGrantId !== null &&
      (typeof value.executionGrantId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(
          value.executionGrantId,
        ))) ||
    typeof value.authorizationNodeId !== 'string' ||
    !DIGEST.test(value.authorizationNodeId) ||
    typeof value.reservationNodeId !== 'string' ||
    !DIGEST.test(value.reservationNodeId) ||
    (value.retryMode === 'strategy-change') !== value.strategyChanges.length > 0
  ) {
    throw invocationInvalid();
  }
  return deepFreeze({
    attemptId: value.attemptId,
    retryMode: value.retryMode as ProviderRetryReplacementBinding['retryMode'],
    strategyChanges: [...value.strategyChanges] as string[],
    environmentDigest: value.environmentDigest,
    executionGrantId: value.executionGrantId as string | null,
    authorizationNodeId: value.authorizationNodeId,
    reservationNodeId: value.reservationNodeId,
  });
}
