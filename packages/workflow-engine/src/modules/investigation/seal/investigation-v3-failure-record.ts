/** Canonical stored failure facts and exact admission; no repository observation. */
import { isRecord } from '../../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../../foundation/repository-path/repository-path.ts';
import { parseInvestigationV3Blocker } from '../manifest/investigation-manifest.ts';
import type { InvestigationV3Blocker } from '../manifest/investigation-manifest-types.ts';
import {
  assertInvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationFailure,
} from '../manifest/investigation-publication-contracts.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

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

export function validRepositoryId(value: unknown): value is string {
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

export function failureObservationInvalid() {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_OBSERVATION_INVALID',
    'Investigation v3 failure observation is unavailable or malformed.',
    ExitCode.verification,
  );
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
