/** Publishes signed authority under its lifecycle lock and terminalizes exact failed publication. */
import {
  runGit,
  isPostApprovalAdmissionFailure,
  enterActivePostApprovalTerminalCleanup,
} from '../repository-transaction/git.ts';
import { createMaintainerAuditTag } from '../repository-transaction/maintainer-audit-tag.ts';
import { withRepositoryLifecycleOperation } from '../session-workspace/session-store.ts';
import type { MaintainerGrantV2Envelope } from '../../modules/authority/maintainer-grant-v2-codec.ts';
import type { MaintainerGrantV2Services } from '../../modules/authority/maintainer-grant-v2.ts';
export type SignedGrantPublicationRuntime = {
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
  /** Only the lifecycle-lock root is read here. */
  maintainerGrantStorePaths(gitCommonDirectory: string): {
    runtime: Parameters<typeof withRepositoryLifecycleOperation>[0];
  };
  createMaintainerAuditTag: typeof createMaintainerAuditTag;
  storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
    gitCommonDirectory: string,
    requestedGrantId: string,
    canonicalEnvelope: string,
    assertOwned: () => void,
  ): void;
  terminallyFailSignedMaintainerGrantV2UnderLifecycleLock(
    gitCommonDirectory: string,
    envelope: MaintainerGrantV2Envelope,
    reason: string,
    now: Date,
    assertOwned: () => void,
  ): void;
  isPostApprovalAdmissionFailure: typeof isPostApprovalAdmissionFailure;
  enterActivePostApprovalTerminalCleanup: typeof enterActivePostApprovalTerminalCleanup;
  exactPublishedAuditTagObject: typeof exactPublishedAuditTagObject;
  deleteExpectedAuditTag: typeof deleteExpectedAuditTag;
};

export function createSignedMaintainerGrantPublisher({
  withRepositoryLifecycleOperation,
  maintainerGrantStorePaths,
  createMaintainerAuditTag,
  storeCanonicalAvailableMaintainerGrantUnderLifecycleLock,
  terminallyFailSignedMaintainerGrantV2UnderLifecycleLock,
  isPostApprovalAdmissionFailure,
  enterActivePostApprovalTerminalCleanup,
  exactPublishedAuditTagObject,
  deleteExpectedAuditTag,
}: SignedGrantPublicationRuntime): MaintainerGrantV2Services['publishSignedMaintainerGrant'] {
  const publishSignedMaintainerGrant: MaintainerGrantV2Services['publishSignedMaintainerGrant'] =
    function publishSignedMaintainerGrant({
      repository,
      baseCommit,
      grantId,
      tagRef,
      envelope,
      canonicalEnvelope,
      signerIdentity,
      now,
      recheckMandate,
    }) {
      const paths = maintainerGrantStorePaths(repository.gitCommonDirectory);
      withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
        assertOwned();
        let tagObject: string | null = null;
        try {
          recheckMandate(assertOwned);
          tagObject = createMaintainerAuditTag(
            repository.repositoryRoot,
            baseCommit,
            tagRef,
            canonicalEnvelope,
            signerIdentity,
          );
          storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
            repository.gitCommonDirectory,
            grantId,
            canonicalEnvelope,
            assertOwned,
          );
        } catch (error) {
          if (isPostApprovalAdmissionFailure(error)) {
            enterActivePostApprovalTerminalCleanup();
            terminallyFailSignedMaintainerGrantV2UnderLifecycleLock(
              repository.gitCommonDirectory,
              envelope,
              error instanceof Error
                ? error.message
                : 'Post-approval grant publication failed.',
              now,
              assertOwned,
            );
            try {
              const cleanupTagObject =
                tagObject ??
                exactPublishedAuditTagObject(
                  repository.repositoryRoot,
                  tagRef,
                  baseCommit,
                  canonicalEnvelope,
                  signerIdentity,
                );
              if (cleanupTagObject !== null) {
                deleteExpectedAuditTag(
                  repository.repositoryRoot,
                  tagRef,
                  cleanupTagObject,
                );
              }
            } catch {
              // Durable failed authority is denial-first. An unknown or
              // concurrently substituted tag is preserved, and cleanup cannot
              // replace the original admission failure.
            }
          } else if (tagObject) {
            deleteExpectedAuditTag(
              repository.repositoryRoot,
              tagRef,
              tagObject,
            );
          }
          throw error;
        }
      });
    };
  return publishSignedMaintainerGrant;
}

export function exactPublishedAuditTagObject(
  repositoryRoot: string,
  tagRef: string,
  baseCommit: string,
  canonicalEnvelope: string,
  signerIdentity: string,
): string | null {
  const tagObject = runGit(
    repositoryRoot,
    ['rev-parse', `${tagRef}^{tag}`],
    true,
  ).trim();
  if (!tagObject) return null;
  const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagObject], true);
  const separator = raw.indexOf('\n\n');
  if (separator === -1) return null;
  const headers = raw.slice(0, separator).split('\n');
  const object = headers.find((line) => line.startsWith('object '))?.slice(7);
  const type = headers.find((line) => line.startsWith('type '))?.slice(5);
  const tag = headers.find((line) => line.startsWith('tag '))?.slice(4);
  const tagger = headers.find((line) => line.startsWith('tagger '));
  const expectedTaggerPrefix = `tagger ${signerIdentity} <workflow-maintainer@users.noreply.github.com> `;
  if (
    headers.length !== 4 ||
    object !== baseCommit ||
    type !== 'commit' ||
    tag !== tagRef.slice('refs/tags/'.length) ||
    !tagger?.startsWith(expectedTaggerPrefix) ||
    raw.slice(separator + 2) !== canonicalEnvelope
  ) {
    return null;
  }
  return tagObject;
}

export function deleteExpectedAuditTag(
  repositoryRoot: string,
  tagRef: string,
  tagObject: string,
): void {
  runGit(repositoryRoot, ['update-ref', '-d', tagRef, tagObject]);
}
