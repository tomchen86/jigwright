import fs from 'node:fs';
import path from 'node:path';

import {
  OpenSpecArchiveProjectionError,
  SPEC_DELTA_VALIDATOR_VERSION,
  combineOpenSpecDeltas,
  assertSpecDeltaPreconditions as assertPackageSpecDeltaPreconditions,
  assertSpecDeltaScenarioPreservation as assertPackageSpecDeltaScenarioPreservation,
  assessSpecDeltaAgainstBase as assessPackageSpecDeltaAgainstBase,
  findDeltaApplicabilityFaults as findPackageDeltaApplicabilityFaults,
  findMissingScenarioIdentities,
  verifyArchiveDeltaOutcomes as verifyPackageArchiveDeltaOutcomes,
  verifyProjectedSpecDeltaOutcome as verifyPackageProjectedSpecDeltaOutcome,
  specDeltaChangesContract as packageSpecDeltaChangesContract,
  type ArchiveDeltaProjection,
  type ArchiveDeltaSource,
  type ArchiveDeltaVerification,
  type DeltaApplicabilityFault,
  type OpenSpecArchiveProjectionReader,
  type SpecDeltaAssessment,
  type SpecDeltaPreflightRecord,
} from '@jigwright/openspec-adapter/archive-projection';

import { readFileAtCommit } from './git.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { readSystemDescriptionSnapshot } from './system-description-snapshot.ts';
import { readSystemSpecDeltaInputs } from '../../modules/source/system-spec-deltas.ts';

export {
  SPEC_DELTA_VALIDATOR_VERSION,
  findMissingScenarioIdentities,
  combineOpenSpecDeltas,
};
export type {
  ArchiveDeltaVerification,
  DeltaApplicabilityFault,
  SpecDeltaAssessment,
  SpecDeltaPreflightRecord,
};

export function verifyArchiveDeltaOutcomes(
  repositoryRoot: string,
  eligibility: ArchiveDeltaSource,
  transformation: ArchiveDeltaProjection,
): ArchiveDeltaVerification {
  return withWorkflowArchiveProjectionErrors(() =>
    verifyPackageArchiveDeltaOutcomes(
      archiveProjectionReader(repositoryRoot),
      eligibility,
      transformation,
    ),
  );
}

export function verifyProjectedSpecDeltaOutcome(
  capability: string,
  before: string,
  delta: string,
  after: string,
): {
  totals: ArchiveDeltaVerification['totals'];
  projectedSpecDigest: string;
} {
  return withWorkflowArchiveProjectionErrors(() =>
    verifyPackageProjectedSpecDeltaOutcome(capability, before, delta, after),
  );
}

export function specDeltaChangesContract(
  capability: string,
  before: string,
  delta: string,
): boolean {
  return withWorkflowArchiveProjectionErrors(() =>
    packageSpecDeltaChangesContract(capability, before, delta),
  );
}

export function assertSpecDeltaPreconditions(
  capability: string,
  before: string,
  delta: string,
): void {
  withWorkflowArchiveProjectionErrors(() =>
    assertPackageSpecDeltaPreconditions(capability, before, delta),
  );
}

export function assertSpecDeltaScenarioPreservation(
  repositoryRoot: string,
  head: string,
  changeRoot: string,
  changeId: string,
  deltaSpecPaths: readonly string[],
  now: Date = new Date(),
): SpecDeltaPreflightRecord {
  return withWorkflowArchiveProjectionErrors(() =>
    assertPackageSpecDeltaScenarioPreservation(
      archiveProjectionReader(repositoryRoot),
      head,
      changeRoot,
      changeId,
      deltaSpecPaths,
      now,
    ),
  );
}

export function assessSpecDeltaAgainstBase(
  baseSpec: string,
  deltaSpec: string,
): SpecDeltaAssessment {
  return withWorkflowArchiveProjectionErrors(() =>
    assessPackageSpecDeltaAgainstBase(baseSpec, deltaSpec),
  );
}

export function findDeltaApplicabilityFaults(
  baseSpec: string,
  deltaSpec: string,
): DeltaApplicabilityFault[] {
  return withWorkflowArchiveProjectionErrors(() =>
    findPackageDeltaApplicabilityFaults(baseSpec, deltaSpec),
  );
}

function archiveProjectionReader(
  repositoryRoot: string,
): OpenSpecArchiveProjectionReader {
  return {
    readSpecDeltaInputs(revision, changeRoot, changeId, deltaSpecPaths) {
      const snapshot = readSystemDescriptionSnapshot(repositoryRoot, revision);
      const prefix = `${changeRoot}/${changeId}/specs/`;
      return readSystemSpecDeltaInputs(
        snapshot,
        deltaSpecPaths ??
          snapshot
            .listPaths()
            .filter(
              (file) => file.startsWith(prefix) && file.endsWith('/spec.md'),
            ),
        deltaSpecPaths
          ? (file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8')
          : snapshot.readText,
      );
    },
    readPinnedText(revision, relativePath) {
      return readFileAtCommit(repositoryRoot, revision, relativePath);
    },
    readCurrentText(relativePath) {
      try {
        return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

function withWorkflowArchiveProjectionErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof OpenSpecArchiveProjectionError)) throw error;
    throw workflowError(
      error.code,
      error.message,
      error.code === 'SPEC_DELTA_PREFLIGHT_TREE_INVALID'
        ? ExitCode.staleState
        : ExitCode.verification,
      error.details === undefined ? {} : { details: { ...error.details } },
    );
  }
}
