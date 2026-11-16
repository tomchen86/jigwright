/** Archive publication Grant use cases over required preparation and record readers. */
import {
  createArchivePullRequestGrantRequest as buildArchivePullRequestGrantRequest,
  archivePullRequestGrantPolicy,
  renderArchivePullRequestGrantChoice,
  archivePullRequestGrantStateBinding,
  archivePullRequestGrantOutcome,
  authenticateCompletedArchivePullRequestGrantRecord,
  archivePullRequestGrantInvalid,
  type ArchivePullRequestGrantParametersV1,
  type ArchivePullRequestPublicationTargetV1,
  type CompletedArchivePullRequestGrantReferenceV1,
} from '../../modules/authority/archive-pr-grant.ts';
import type { ArchivePublicationPreparationV1 } from '../../modules/authority/archive-publication-preparation.ts';
import type { GrantRecordStore } from '../../modules/authority/grant-record-store.ts';
import type { GrantRequestInput } from '../../modules/authority/grant-core.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
} from '../../modules/authority/grant-transition-registry.ts';

export type ArchivePublicationPreparationReader = (
  preparationIdentity: string,
) => ArchivePublicationPreparationV1;

/** Publication receives this capability without knowing physical Grant paths. */
export type ArchivePullRequestGrantAuthenticator = (
  runtimeRoot: string,
  challengeId: string,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  now?: Date,
) => CompletedArchivePullRequestGrantReferenceV1;

export function createArchivePullRequestGrantRequest(
  readPreparation: ArchivePublicationPreparationReader,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  proposedReason: string,
): GrantRequestInput {
  const preparation = readPreparation(preparationIdentity);
  return buildArchivePullRequestGrantRequest(
    preparation,
    publicationTarget,
    proposedReason,
  );
}

export function archivePullRequestGrantTransitionDefinitions(
  readPreparation: ArchivePublicationPreparationReader,
): readonly TransitionDefinition<ArchivePullRequestGrantParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      ...archivePullRequestGrantPolicy(),
      renderTrustedChoice(parameters: ArchivePullRequestGrantParametersV1) {
        const preparation = readPreparation(parameters.preparationIdentity);
        return renderArchivePullRequestGrantChoice(preparation, parameters);
      },
      observeState(parameters: ArchivePullRequestGrantParametersV1) {
        return archivePullRequestGrantStateBinding(
          readPreparation(parameters.preparationIdentity),
          parameters.publicationTarget,
        );
      },
      async execute(
        context: AuthorizedTransitionContext<ArchivePullRequestGrantParametersV1>,
      ) {
        context.assertLifecycleOwned();
        let preparation: ArchivePublicationPreparationV1;
        try {
          preparation = readPreparation(context.parameters.preparationIdentity);
        } catch {
          throw grantTransitionPreconditionChanged(
            'ARCHIVE_PR_PREPARATION_STALE',
            'The exact archive publication preparation is no longer available.',
          );
        }
        context.assertLifecycleOwned();
        return archivePullRequestGrantOutcome(
          preparation,
          context.parameters.publicationTarget,
        );
      },
    }),
  ]);
}

export function authenticateCompletedArchivePullRequestGrant(
  readPreparation: ArchivePublicationPreparationReader,
  readGrantRecord: GrantRecordStore['readGrantRecord'],
  challengeId: string,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  now: Date,
): CompletedArchivePullRequestGrantReferenceV1 {
  try {
    const preparation = readPreparation(preparationIdentity);
    const record = readGrantRecord(challengeId);
    return authenticateCompletedArchivePullRequestGrantRecord(
      preparation,
      record,
      publicationTarget,
      now,
    );
  } catch {
    throw archivePullRequestGrantInvalid();
  }
}
