/** Collaboration revocation preserves lock-bound observation, human authorization and terminal publication order. */
import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';
import { type TaskMandateOperations } from '../../modules/authority/task-mandate.ts';
import {
  type HumanRevocationAuthorizer,
  type HumanRevocationOptions,
  digestHumanRevocationSubject,
} from '../../modules/authority/human-revocation-contract.ts';
import { type WithCollaborationRevocationStore } from '../../modules/authority/grant-revocation-contract.ts';
import {
  type CollaborationGrantCodec,
  assertCollaborationGrantId,
} from '../../modules/authority/collaboration-grant-codec.ts';
import type { CollaborationGrantInspection } from '../../modules/authority/collaboration-grant-records.ts';
import { deriveAuthorityAuditRepositoryId } from '../../modules/authority/authority-audit-contract.ts';
import { exactDate } from '../../modules/authority/collaboration-grant-values.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
export type CollaborationGrantRevocationServices = Readonly<{
  now: () => Date;
  discoverRepository: (
    cwd: string,
  ) => Pick<GitState, 'repositoryRoot' | 'gitCommonDirectory'>;
  taskMandate: Pick<TaskMandateOperations, 'inspectTaskMandate'>;
  authorizeHumanRevocation: HumanRevocationAuthorizer;
  collaborationGrants: Pick<
    CollaborationGrantCodec,
    'canonicalCollaborationGrantEnvelope'
  >;
  withStoreLock: WithCollaborationRevocationStore;
}>;
export function createCollaborationGrantRevoker(
  services: CollaborationGrantRevocationServices,
) {
  function revokeCollaborationGrant(
    cwd: string,
    requestedGrantId: string,
    options: HumanRevocationOptions,
  ): CollaborationGrantInspection {
    const repository = services.discoverRepository(cwd);
    const grantId = assertCollaborationGrantId(requestedGrantId);
    return services.withStoreLock(
      repository.gitCommonDirectory,
      repository.repositoryRoot,
      (store) => {
        store.assertOwned();
        const target = store.readTarget(grantId);
        const payload = target.envelope.payload;
        store.assertTarget(
          target.envelope,
          exactDate(options.now ?? services.now()),
        );
        let audit: {
          externalAuditRoot: string;
          repositoryId: ReturnType<typeof deriveAuthorityAuditRepositoryId>;
        } | null = null;
        if (payload.taskId !== null) {
          const mandate = services.taskMandate.inspectTaskMandate(
            repository.repositoryRoot,
            payload.taskId,
            {
              now: options.now,
              signer: options.verifier ?? options.signer,
            },
          );
          if (mandate.changeId !== payload.changeId) {
            throw workflowError(
              'HUMAN_REVOCATION_BINDING_INVALID',
              'Collaboration revocation task mandate binding is unavailable or different.',
              ExitCode.guard,
            );
          }
          audit = {
            externalAuditRoot: mandate.externalAuditRoot,
            repositoryId: deriveAuthorityAuditRepositoryId(
              payload.repositoryId,
            ),
          };
        }
        const authorization = services.authorizeHumanRevocation(
          repository.repositoryRoot,
          {
            subjectKind: 'collaboration-grant',
            grantId,
            grantDigest: digestHumanRevocationSubject(
              services.collaborationGrants.canonicalCollaborationGrantEnvelope(
                target.envelope,
              ),
            ),
            repositoryId: payload.repositoryId,
            repositoryOrigin: payload.repositoryOrigin,
            changeId: payload.changeId,
            taskId: payload.taskId,
            workflowId: null,
            audit,
          },
          options,
          store.authorizationPath(grantId),
          target.authorization,
        );
        return store.publish(target, authorization);
      },
    );
  }
  return revokeCollaborationGrant;
}
