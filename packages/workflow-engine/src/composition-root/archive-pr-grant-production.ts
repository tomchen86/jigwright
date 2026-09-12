/** Bind archive Grant observations to their actual preparation and Grant stores. */
import {
  createArchivePullRequestGrantRequest as requestWithPreparation,
  archivePullRequestGrantTransitionDefinitions as transitionsWithPreparation,
  authenticateCompletedArchivePullRequestGrant as authenticateWithReaders,
  type ArchivePullRequestGrantAuthenticator,
} from '../application/archive/archive-pr-grant.ts';
import type { ArchivePullRequestPublicationTargetV1 } from '../modules/authority/archive-pr-grant.ts';
import { readArchivePublicationPreparation } from '../runtime/storage-journal/archive-publication-store.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../runtime/storage-journal/grant-store.ts';

export function createArchivePullRequestGrantRequest(
  runtimeRoot: string,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  proposedReason: string,
) {
  return requestWithPreparation(
    (identity) => readArchivePublicationPreparation(runtimeRoot, identity),
    preparationIdentity,
    publicationTarget,
    proposedReason,
  );
}

export function archivePullRequestGrantTransitionDefinitions(
  runtimeRoot: string,
) {
  return transitionsWithPreparation((identity) =>
    readArchivePublicationPreparation(runtimeRoot, identity),
  );
}

export const authenticateCompletedArchivePullRequestGrant: ArchivePullRequestGrantAuthenticator =
  (runtimeRoot, challengeId, preparationIdentity, publicationTarget, now) => {
    // Path observations and the default clock stay outside authentication's catch.
    const paths = grantStorePaths(runtimeRoot);
    const observedAt = now === undefined ? new Date() : now;
    return authenticateWithReaders(
      (identity) => readArchivePublicationPreparation(runtimeRoot, identity),
      (id) => createFileGrantRecordStore(paths).readGrantRecord(id),
      challengeId,
      preparationIdentity,
      publicationTarget,
      observedAt,
    );
  };
