/**
 * Persists and reads current direct or publication investigation failure
 * observations.
 *
 * Invariants:
 * - Failure observations must validate against the requested investigation
 *   identity.
 */
import path from 'node:path';

import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseInvestigationV3Blocker,
  type InvestigationV3Blocker,
} from '../../modules/investigation/manifest/investigation-manifest.ts';
import {
  assertInvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationFailure,
} from '../managed-documents/transaction/investigation-publication.ts';
import {
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';
import {
  assertChangeId,
  assertInvestigationId,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type InvestigationV3DirectFailureEmission = Readonly<{
  schemaVersion: 1;
  sessionSnapshotDigest: string;
  currentRefDigest: `sha256:${string}`;
  effectiveState:
    | 'actor-resolution-required'
    | 'human-action-required'
    | 'awaiting-main-terms'
    | 'waiting-for-provider'
    | 'awaiting-group-dispositions'
    | 'awaiting-ledger-answers'
    | 'investigation-sealed'
    | 'investigation-exempt';
  lifecycleStateDigest: `sha256:${string}`;
  gitStateDigest: `sha256:${string}`;
}>;

export type InvestigationV3FailureObservation = Readonly<{
  schemaVersion: 2;
  kind: 'investigation-v3-failure-observation';
  authorityEligible: false;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  emission: InvestigationV3DirectFailureEmission;
  blocker: InvestigationV3Blocker;
}>;

export type InvestigationV3PublicationFailureObservation = Readonly<{
  schemaVersion: 1;
  kind: 'investigation-v3-publication-failure-observation';
  authorityEligible: false;
  failure: InvestigationManifestPublicationFailure;
}>;

export type InvestigationV3StoredFailureObservation =
  | InvestigationV3FailureObservation
  | InvestigationV3PublicationFailureObservation;

/** Persist one direct-v3 failure fact for central Grant currentness replay. */
export function writeInvestigationV3FailureObservation(input: {
  runtime: InvestigationRuntimePaths;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  emission: InvestigationV3DirectFailureEmission;
  blocker: InvestigationV3Blocker;
}): string {
  const observation = assertInvestigationV3FailureObservation({
    schemaVersion: 2,
    kind: 'investigation-v3-failure-observation',
    authorityEligible: false,
    repositoryId: input.repositoryId,
    changeId: input.changeId,
    investigationId: input.investigationId,
    sessionRevision: input.sessionRevision,
    sessionSnapshotDigest: input.sessionSnapshotDigest,
    emission: input.emission,
    blocker: input.blocker,
  });
  const filePath = investigationV3FailureObservationPath(
    input.runtime,
    observation.investigationId,
  );
  writePrivateCanonicalJsonAtomic(
    input.runtime,
    filePath,
    observation,
    failureStoreInvalid,
  );
  return filePath;
}

/** Persist one full publication failure envelope in the shared current slot. */
export function writeInvestigationV3PublicationFailureObservation(input: {
  runtime: InvestigationRuntimePaths;
  failure: InvestigationManifestPublicationFailure;
}): string {
  const observation = assertInvestigationV3PublicationFailureObservation({
    schemaVersion: 1,
    kind: 'investigation-v3-publication-failure-observation',
    authorityEligible: false,
    failure: input.failure,
  });
  const filePath = investigationV3FailureObservationPath(
    input.runtime,
    observation.failure.lifecycle.investigationId,
  );
  writePrivateCanonicalJsonAtomic(
    input.runtime,
    filePath,
    observation,
    failureStoreInvalid,
  );
  return filePath;
}

/** Replace any prior failure with a non-authorizing success tombstone. */
export function clearInvestigationV3FailureObservation(input: {
  runtime: InvestigationRuntimePaths;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  manifestDigest: string;
}): string {
  if (
    !validRepositoryId(input.repositoryId) ||
    assertChangeId(input.changeId) !== input.changeId ||
    assertInvestigationId(input.investigationId) !== input.investigationId ||
    !Number.isSafeInteger(input.sessionRevision) ||
    input.sessionRevision < 0 ||
    !DIGEST.test(input.sessionSnapshotDigest) ||
    !DIGEST.test(input.manifestDigest)
  ) {
    throw failureStoreInvalid();
  }
  const filePath = investigationV3FailureObservationPath(
    input.runtime,
    input.investigationId,
  );
  writePrivateCanonicalJsonAtomic(
    input.runtime,
    filePath,
    deepFreeze({
      schemaVersion: 1 as const,
      kind: 'investigation-v3-failure-cleared' as const,
      authorityEligible: false as const,
      repositoryId: input.repositoryId,
      changeId: input.changeId,
      investigationId: input.investigationId,
      sessionRevision: input.sessionRevision,
      sessionSnapshotDigest: input.sessionSnapshotDigest,
      manifestDigest: input.manifestDigest,
    }),
    failureStoreInvalid,
  );
  return filePath;
}

export function readInvestigationV3FailureObservation(
  runtime: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): InvestigationV3FailureObservation {
  try {
    const observed = readCurrentInvestigationV3FailureObservation(
      runtime,
      requestedInvestigationId,
    );
    if (observed.kind !== 'investigation-v3-failure-observation') {
      throw failureObservationInvalid();
    }
    return observed;
  } catch {
    throw failureObservationInvalid();
  }
}

export function readCurrentInvestigationV3FailureObservation(
  runtime: InvestigationRuntimePaths,
  requestedInvestigationId: string,
): InvestigationV3StoredFailureObservation {
  try {
    const investigationId = assertInvestigationId(requestedInvestigationId);
    const raw = readPrivateCanonicalJson(
      runtime,
      investigationV3FailureObservationPath(runtime, investigationId),
      failureObservationInvalid,
    );
    if (
      isRecord(raw) &&
      raw.kind === 'investigation-v3-publication-failure-observation'
    ) {
      return assertInvestigationV3PublicationFailureObservation(
        raw,
        investigationId,
      );
    }
    return assertInvestigationV3FailureObservation(raw, investigationId);
  } catch {
    throw failureObservationInvalid();
  }
}

export function assertInvestigationV3FailureObservation(
  value: unknown,
  expectedInvestigationId?: string,
): InvestigationV3FailureObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'authorityEligible',
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'emission',
      'blocker',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'investigation-v3-failure-observation' ||
    value.authorityEligible !== false ||
    !validRepositoryId(value.repositoryId) ||
    typeof value.changeId !== 'string' ||
    assertChangeId(value.changeId) !== value.changeId ||
    typeof value.investigationId !== 'string' ||
    assertInvestigationId(value.investigationId) !== value.investigationId ||
    (expectedInvestigationId !== undefined &&
      value.investigationId !== expectedInvestigationId) ||
    typeof value.sessionRevision !== 'number' ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 0 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !DIGEST.test(value.sessionSnapshotDigest)
  ) {
    throw failureObservationInvalid();
  }
  const emission = assertInvestigationV3DirectFailureEmission(value.emission);
  if (emission.sessionSnapshotDigest !== value.sessionSnapshotDigest) {
    throw failureObservationInvalid();
  }
  return deepFreeze({
    schemaVersion: 2,
    kind: 'investigation-v3-failure-observation',
    authorityEligible: false,
    repositoryId: value.repositoryId,
    changeId: value.changeId,
    investigationId: value.investigationId,
    sessionRevision: value.sessionRevision,
    sessionSnapshotDigest: value.sessionSnapshotDigest,
    emission,
    blocker: parseInvestigationV3Blocker(value.blocker),
  });
}

export function assertInvestigationV3PublicationFailureObservation(
  value: unknown,
  expectedInvestigationId?: string,
): InvestigationV3PublicationFailureObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'authorityEligible',
      'failure',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-v3-publication-failure-observation' ||
    value.authorityEligible !== false
  ) {
    throw failureObservationInvalid();
  }
  const failure = assertInvestigationManifestPublicationFailure(value.failure);
  if (
    expectedInvestigationId !== undefined &&
    failure.lifecycle.investigationId !== expectedInvestigationId
  ) {
    throw failureObservationInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'investigation-v3-publication-failure-observation',
    authorityEligible: false,
    failure,
  });
}

export function assertInvestigationV3DirectFailureEmission(
  value: unknown,
): InvestigationV3DirectFailureEmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'sessionSnapshotDigest',
      'currentRefDigest',
      'effectiveState',
      'lifecycleStateDigest',
      'gitStateDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !DIGEST.test(value.sessionSnapshotDigest) ||
    typeof value.currentRefDigest !== 'string' ||
    !PREFIXED_DIGEST.test(value.currentRefDigest) ||
    ![
      'actor-resolution-required',
      'human-action-required',
      'awaiting-main-terms',
      'waiting-for-provider',
      'awaiting-group-dispositions',
      'awaiting-ledger-answers',
      'investigation-sealed',
      'investigation-exempt',
    ].includes(String(value.effectiveState)) ||
    typeof value.lifecycleStateDigest !== 'string' ||
    !PREFIXED_DIGEST.test(value.lifecycleStateDigest) ||
    typeof value.gitStateDigest !== 'string' ||
    !PREFIXED_DIGEST.test(value.gitStateDigest)
  ) {
    throw failureObservationInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    sessionSnapshotDigest: value.sessionSnapshotDigest,
    currentRefDigest: value.currentRefDigest as `sha256:${string}`,
    effectiveState:
      value.effectiveState as InvestigationV3DirectFailureEmission['effectiveState'],
    lifecycleStateDigest: value.lifecycleStateDigest as `sha256:${string}`,
    gitStateDigest: value.gitStateDigest as `sha256:${string}`,
  });
}

export function investigationV3FailureObservationPath(
  runtime: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(
    runtime.root,
    'investigation-v3-failures',
    `${assertInvestigationId(investigationId)}.json`,
  );
}

function validRepositoryId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function failureStoreInvalid() {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_STORE_INVALID',
    'Investigation v3 failure observation storage is unsafe.',
    ExitCode.verification,
  );
}

function failureObservationInvalid() {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_OBSERVATION_INVALID',
    'Investigation v3 failure observation is unavailable or malformed.',
    ExitCode.verification,
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
