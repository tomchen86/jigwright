import {
  DIGEST,
  validRepositoryId,
  failureObservationInvalid,
  deepFreeze,
  assertInvestigationV3FailureObservation,
  assertInvestigationV3PublicationFailureObservation,
  type InvestigationV3DirectFailureEmission,
  type InvestigationV3FailureObservation,
  type InvestigationV3StoredFailureObservation,
} from '../../modules/investigation/seal/investigation-v3-failure-record.ts';
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
import { type InvestigationV3Blocker } from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import { type InvestigationManifestPublicationFailure } from '../../modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-private-files.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../foundation/repository-path/repository-path.ts';

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

function failureStoreInvalid() {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_STORE_INVALID',
    'Investigation v3 failure observation storage is unsafe.',
    ExitCode.verification,
  );
}
