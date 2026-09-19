/** Reads the requested Git authority facts without observing later phases early. */
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../../modules/authority/maintainer-policy.ts';
import {
  OID,
  approvalInvalid,
  type TaskRevisionApprovalRepository,
} from '../../modules/authority/task-revision-approval-contracts.ts';
import { resolveBlobOid } from '../repository-transaction/git-object-ids.ts';

export const taskRevisionApprovalRepository: TaskRevisionApprovalRepository = {
  inspect: discoverRepository,
  policyAt: loadPolicyAtCommit,
  origin: (repositoryRoot) =>
    runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim(),
};

function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): { policy: MaintainerPolicy; policyBlob: string } {
  if (!OID.test(commit)) {
    throw approvalInvalid('Task-revision approval baseline is invalid.');
  }
  try {
    return {
      policy: parseMaintainerPolicy(
        JSON.parse(
          runGit(repositoryRoot, [
            'show',
            `${commit}:workflow/maintainer-policy.json`,
          ]),
        ),
      ),
      policyBlob: resolveBlobOid(
        repositoryRoot,
        commit,
        'workflow/maintainer-policy.json',
      ),
    };
  } catch {
    throw approvalInvalid(
      'The exact task-revision baseline has no valid maintainer policy.',
    );
  }
}
