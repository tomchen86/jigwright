/**
 * Quarantines unsafe investigation refs and start reservations under exact observations.
 *
 * Invariants:
 * - Quarantine acts only on the previously observed unsafe path and expected state.
 * - Rename, directory fsync, conflict checks, and lifecycle locking retain their order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../foundation/repository-path/repository-path.ts';
import { readHumanResolutionHead } from './human-resolution-nodes.ts';
import { inspectInvestigationQuarantineState } from './human-resolution-state.ts';
import {
  canonicalPrivateContent,
  createPrivateRawFile,
  ensurePrivateInvestigationDirectory,
  fsyncDirectory,
  readPrivateFile,
  walkPrivateDirectory,
  withPrivateRuntimeLock,
} from './investigation-private-files.ts';
import {
  currentInvestigationRefPath,
  humanResolutionArchiveUnsafe,
  humanResolutionPaths,
  humanResolutionRecoveryAmbiguous,
  humanResolutionRefPath,
  humanResolutionRefUnsafe,
  investigationStartReservationPath,
  observeUnsafePath,
  refUnsafe,
  startReservationUnsafe,
} from './investigation-resolution-values.ts';
import { isBoundedResolutionText } from '../../modules/investigation/domain/human-resolution-values.ts';
import { readCurrentInvestigationRef } from './investigation-session-records.ts';
import {
  isDigest,
  sha256,
} from '../../modules/investigation/domain/investigation-store-values.ts';

export function quarantineUnsafeCurrentInvestigationRef(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedObservationDigest: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  if (!isDigest(expectedObservationDigest)) {
    throw refUnsafe();
  }
  const source = currentInvestigationRefPath(paths, changeId);
  const quarantineDirectory = humanResolutionPaths(paths).quarantine;
  const target = path.join(
    quarantineDirectory,
    `${changeId}.${expectedObservationDigest}.artifact`,
  );
  return withPrivateRuntimeLock(
    paths,
    path.join(paths.locks, `${changeId}.current-investigation.lock`),
    () => {
      if (
        !walkPrivateDirectory(paths, path.dirname(source), refUnsafe, false)
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref disappeared before quarantine.',
          ExitCode.staleState,
        );
      }
      const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStats) {
        const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (
          targetStats &&
          observeUnsafePath(target, 'current-ref', []) ===
            expectedObservationDigest
        ) {
          return target;
        }
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref changed before quarantine.',
          ExitCode.staleState,
        );
      }
      if (
        observeUnsafePath(source, 'current-ref', []) !==
        expectedObservationDigest
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_REF_STALE',
          'The current investigation ref changed before quarantine.',
          ExitCode.staleState,
        );
      }
      try {
        readCurrentInvestigationRef(paths, changeId);
      } catch {
        // The exact malformed object is the only object this transition moves.
      }
      ensurePrivateInvestigationDirectory(
        paths,
        quarantineDirectory,
        humanResolutionArchiveUnsafe,
      );
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw workflowError(
          'CURRENT_INVESTIGATION_QUARANTINE_CONFLICT',
          'A different quarantine artifact already occupies the exact target.',
          ExitCode.conflict,
        );
      }
      fs.renameSync(source, target);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(quarantineDirectory);
      return target;
    },
    'CURRENT_INVESTIGATION_OPERATION_CONFLICT',
    refUnsafe,
  );
}

export function archiveHumanResolutionSingleton(
  paths: InvestigationRuntimePaths,
  kind: 'start-reservation' | 'evidence-refs',
  expectedDigest: string,
  content: string,
  newlineRequired: boolean,
): string {
  if (!isDigest(expectedDigest)) {
    throw humanResolutionRecoveryAmbiguous();
  }
  const targetDirectory = path.join(
    humanResolutionPaths(paths).retiredRefs,
    kind,
  );
  const target = path.join(targetDirectory, `${expectedDigest}.artifact`);
  if (
    sha256(content) !== expectedDigest ||
    !canonicalPrivateContent(content, newlineRequired)
  ) {
    throw humanResolutionRecoveryAmbiguous();
  }
  ensurePrivateInvestigationDirectory(
    paths,
    targetDirectory,
    humanResolutionArchiveUnsafe,
  );
  const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (targetStats) {
    const targetContent = readPrivateFile(target, humanResolutionArchiveUnsafe);
    if (
      sha256(targetContent) !== expectedDigest ||
      !canonicalPrivateContent(targetContent, newlineRequired) ||
      targetContent !== content
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
    return expectedDigest;
  }
  createPrivateRawFile(paths, target, content, humanResolutionArchiveUnsafe);
  return expectedDigest;
}

export function quarantineUnsafeInvestigationStartReservation(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedObservationDigest: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  if (!isDigest(expectedObservationDigest)) {
    throw humanResolutionRecoveryAmbiguous();
  }
  const object = 'start-reservation';
  const source = investigationStartReservationPath(paths, changeId);
  const sourceDirectory = path.dirname(source);
  const quarantineDirectory = humanResolutionPaths(paths).quarantine;
  const target = path.join(
    quarantineDirectory,
    `${changeId}.${expectedObservationDigest}.start-reservation.artifact`,
  );
  const lockPath = path.join(
    paths.locks,
    `${changeId}.investigation-start.lock`,
  );
  const makeError = startReservationUnsafe;
  return withPrivateRuntimeLock(
    paths,
    lockPath,
    () => {
      if (!walkPrivateDirectory(paths, sourceDirectory, makeError, false)) {
        throw humanResolutionRecoveryAmbiguous();
      }
      const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStats) {
        const targetStats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (
          targetStats &&
          observeUnsafePath(target, object, []) === expectedObservationDigest
        ) {
          return target;
        }
        throw humanResolutionRecoveryAmbiguous();
      }
      if (observeUnsafePath(source, object, []) !== expectedObservationDigest) {
        throw humanResolutionRecoveryAmbiguous();
      }
      ensurePrivateInvestigationDirectory(
        paths,
        quarantineDirectory,
        humanResolutionArchiveUnsafe,
      );
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw humanResolutionRecoveryAmbiguous();
      }
      fs.renameSync(source, target);
      fsyncDirectory(sourceDirectory);
      fsyncDirectory(quarantineDirectory);
      if (observeUnsafePath(target, object, []) !== expectedObservationDigest) {
        throw humanResolutionRecoveryAmbiguous();
      }
      return target;
    },
    'HUMAN_RESOLUTION_SINGLETON_OPERATION_CONFLICT',
    makeError,
  );
}

export function quarantineUnsafeHumanResolutionRef(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  repositoryId: string,
  expectedStateDigest: string,
): string {
  const investigationId = assertInvestigationId(requestedInvestigationId);
  if (
    !isBoundedResolutionText(repositoryId, 1024) ||
    !isDigest(expectedStateDigest)
  ) {
    throw humanResolutionRefUnsafe();
  }
  const source = humanResolutionRefPath(paths, investigationId);
  const quarantineDirectory = humanResolutionPaths(paths).quarantine;
  const target = path.join(
    quarantineDirectory,
    `${investigationId}.${expectedStateDigest}.resolution-ref-artifact`,
  );
  return withPrivateRuntimeLock(
    paths,
    path.join(
      humanResolutionPaths(paths).locks,
      `${investigationId}.resolution.lock`,
    ),
    () => {
      if (
        !walkPrivateDirectory(
          paths,
          path.dirname(source),
          humanResolutionRefUnsafe,
          false,
        )
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution ref disappeared before quarantine.',
          ExitCode.staleState,
        );
      }
      const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!sourceStats) {
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
          return target;
        }
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution ref changed before quarantine.',
          ExitCode.staleState,
        );
      }
      const observed = inspectInvestigationQuarantineState(
        paths,
        investigationId,
        repositoryId,
      );
      if (
        observed.currentStateDigest !== expectedStateDigest ||
        observed.envelope.ambiguityDigest === null
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'The human-resolution ref changed after grant issuance.',
          ExitCode.staleState,
        );
      }
      try {
        readHumanResolutionHead(paths, investigationId);
        throw workflowError(
          'HUMAN_RESOLUTION_REF_STALE',
          'A readable human-resolution ref cannot use the unsafe-ref quarantine transition.',
          ExitCode.staleState,
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'HUMAN_RESOLUTION_REF_STALE'
        ) {
          throw error;
        }
      }
      ensurePrivateInvestigationDirectory(
        paths,
        quarantineDirectory,
        humanResolutionArchiveUnsafe,
      );
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw workflowError(
          'HUMAN_RESOLUTION_QUARANTINE_CONFLICT',
          'A different quarantine artifact already occupies the exact target.',
          ExitCode.conflict,
        );
      }
      fs.renameSync(source, target);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(quarantineDirectory);
      return target;
    },
    'HUMAN_RESOLUTION_OPERATION_CONFLICT',
    humanResolutionRefUnsafe,
  );
}
