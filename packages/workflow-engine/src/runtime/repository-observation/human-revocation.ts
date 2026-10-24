/** Observes the current revocation policy and repository origin at the caller's phase. */
import { runGit } from '../repository-transaction/git.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { HumanRevocationServices } from '../../modules/authority/human-revocation-contract.ts';
export const loadCurrentPolicy: HumanRevocationServices['loadCurrentPolicy'] = (
  repositoryRoot,
) => {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          'HEAD:workflow/maintainer-policy.json',
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The current HEAD does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
};
export const readRepositoryOrigin: HumanRevocationServices['readRepositoryOrigin'] =
  (repositoryRoot) =>
    runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
