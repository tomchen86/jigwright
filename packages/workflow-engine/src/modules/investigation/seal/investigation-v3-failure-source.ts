/** Binds canonical failure sources to their exact observer schema. */
import { isRecord } from '../../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  grantHasExactKeys as hasExactKeys,
} from '../../authority/grant-primitives.ts';
import type { InvestigationV3Blocker } from '../manifest/investigation-manifest-types.ts';
import {
  assertInvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationFailure,
  type InvestigationManifestPublicationObservationSource,
} from '../manifest/investigation-publication-contracts.ts';
import {
  assertInvestigationV3DirectFailureEmission,
  type InvestigationV3DirectFailureEmission,
} from './investigation-v3-failure-record.ts';

export const INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER =
  'investigation-v3.direct-failure.v1' as const;

export const INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER =
  'investigation-v3.publication-state.v1' as const;

export type InvestigationV3FailureIdentity = Readonly<{
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  blocker: InvestigationV3Blocker;
}>;

export type InvestigationV3FailureSource =
  | Readonly<{
      schemaVersion: 2;
      observerId: typeof INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER;
      emission: InvestigationV3DirectFailureEmission;
    }>
  | Readonly<{
      schemaVersion: 1;
      observerId: typeof INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER;
      source: InvestigationManifestPublicationFailure['source'];
    }>;

export type InvestigationV3ObservedFailureSource = Readonly<{
  identity: InvestigationV3FailureIdentity;
  sourceStateDigest: `sha256:${string}`;
  publicationRecoveryKind:
    'none' | 'pre-ref' | 'post-ref' | 'committed' | 'blocked' | null;
}>;

export function investigationV3DirectFailureSource(
  emission: InvestigationV3DirectFailureEmission,
): InvestigationV3FailureSource {
  return freezeCanonical({
    schemaVersion: 2,
    observerId: INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER,
    emission: assertInvestigationV3DirectFailureEmission(emission),
  });
}

export function investigationV3PublicationFailureSource(
  failure: InvestigationManifestPublicationFailure,
): InvestigationV3FailureSource {
  const parsed = assertInvestigationManifestPublicationFailure(failure);
  return assertInvestigationV3FailureSource({
    schemaVersion: 1,
    observerId: INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER,
    source: parsed.source,
  });
}

export function assertInvestigationV3FailureSource(
  value: unknown,
): InvestigationV3FailureSource {
  if (
    !isRecord(value) ||
    typeof value.schemaVersion !== 'number' ||
    typeof value.observerId !== 'string'
  ) {
    throw sourceInvalid('Investigation v3 failure source is malformed.');
  }
  if (value.observerId === INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER) {
    if (
      value.schemaVersion !== 2 ||
      !hasExactKeys(value, ['schemaVersion', 'observerId', 'emission'])
    ) {
      throw sourceInvalid(
        'Investigation v3 direct failure source is malformed.',
      );
    }
    return freezeCanonical({
      schemaVersion: 2 as const,
      observerId: INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER,
      emission: assertInvestigationV3DirectFailureEmission(value.emission),
    });
  }
  if (
    value.schemaVersion !== 1 ||
    value.observerId !== INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER
  ) {
    throw sourceInvalid('Investigation v3 failure source observer is unknown.');
  }
  if (!hasExactKeys(value, ['schemaVersion', 'observerId', 'source'])) {
    throw sourceInvalid('Investigation v3 publication source is malformed.');
  }
  return freezeCanonical({
    schemaVersion: 1 as const,
    observerId: INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER,
    source: assertPublicationFailureSource(value.source),
  });
}

function assertPublicationFailureSource(
  value: unknown,
): InvestigationManifestPublicationFailure['source'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'observation',
      'failureIdentity',
      'emittedPublicationStateDigest',
      'emittedGitStateDigest',
      'recoveryPolicy',
      'emissionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.failureIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.failureIdentity) ||
    typeof value.emittedPublicationStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.emittedPublicationStateDigest) ||
    typeof value.emittedGitStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.emittedGitStateDigest) ||
    (value.recoveryPolicy !== 'central-grant' &&
      value.recoveryPolicy !== 'idempotent-post-ref') ||
    typeof value.emissionDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.emissionDigest)
  ) {
    throw sourceInvalid('Investigation v3 publication source is malformed.');
  }
  return freezeCanonical({
    schemaVersion: 1 as const,
    observation: assertPublicationSource(value.observation),
    failureIdentity: value.failureIdentity,
    emittedPublicationStateDigest:
      value.emittedPublicationStateDigest as `sha256:${string}`,
    emittedGitStateDigest: value.emittedGitStateDigest as `sha256:${string}`,
    recoveryPolicy: value.recoveryPolicy as
      'central-grant' | 'idempotent-post-ref',
    emissionDigest: value.emissionDigest as `sha256:${string}`,
  });
}

function assertPublicationSource(
  value: unknown,
): InvestigationManifestPublicationObservationSource {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw sourceInvalid(
      'Investigation v3 publication observer input is malformed.',
    );
  }
  if (value.operation === 'read-ref') {
    if (
      !hasExactKeys(value, ['operation', 'currentRefPath']) ||
      !boundedPath(value.currentRefPath)
    ) {
      throw sourceInvalid('Investigation v3 current-ref source is malformed.');
    }
    return freezeCanonical({
      operation: 'read-ref' as const,
      currentRefPath: value.currentRefPath,
    });
  }
  if (!['publish', 'inspect', 'resume'].includes(value.operation)) {
    throw sourceInvalid('Investigation v3 publication operation is unknown.');
  }
  if (!hasExactKeys(value, ['operation', 'paths']) || !isRecord(value.paths)) {
    throw sourceInvalid('Investigation v3 publication paths are malformed.');
  }
  const paths = value.paths;
  if (
    !hasExactKeys(paths, ['manifestPath', 'currentRefPath', 'journalPath']) ||
    !boundedPath(paths.manifestPath) ||
    !boundedPath(paths.currentRefPath) ||
    !boundedPath(paths.journalPath)
  ) {
    throw sourceInvalid('Investigation v3 publication paths are malformed.');
  }
  return freezeCanonical({
    operation: value.operation as 'publish' | 'inspect' | 'resume',
    paths: {
      manifestPath: paths.manifestPath,
      currentRefPath: paths.currentRefPath,
      journalPath: paths.journalPath,
    },
  });
}

function boundedPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4_096 &&
    !/[\0\r\n]/.test(value)
  );
}

function sourceInvalid(message: string) {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_SOURCE_INVALID',
    message,
    ExitCode.guard,
  );
}
/** Current repository observations required by Grant producers and replay. */
export type InvestigationV3FailureObservations = Readonly<{
  readRepositoryId(cwd: string): string;
  initialInvestigationV3FailureSourceObservation(input: {
    cwd: string;
    identity: InvestigationV3FailureIdentity;
    source: InvestigationV3FailureSource;
  }): InvestigationV3ObservedFailureSource;
  observeInvestigationV3FailureSource(input: {
    cwd: string;
    expectedIdentity: InvestigationV3FailureIdentity;
    source: InvestigationV3FailureSource;
  }): InvestigationV3ObservedFailureSource;
  captureInvestigationV3DirectFailureEmission(input: {
    cwd: string;
    identity: InvestigationV3FailureIdentity;
  }): InvestigationV3DirectFailureEmission;
}>;
