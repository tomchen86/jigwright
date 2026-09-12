/** Reads the exact Git policy trust context used by Task Mandates. */
import {
  runGit,
  discoverRepository,
  isPostApprovalAdmissionFailure,
} from '../repository-transaction/git.ts';
import { createInteractiveSshSigner } from '../../adapters/signing/ssh/maintainer-signer.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { isWorkflowFailure } from '../../modules/authority/task-mandate-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { TaskMandateRepositoryServices } from '../../modules/authority/task-mandate-services.ts';
function loadPolicyAt(repositoryRoot: string, commit: string) {
  try {
    const content = runGit(repositoryRoot, [
      'show',
      `${commit}:workflow/maintainer-policy.json`,
    ]);
    return {
      policy: parseMaintainerPolicy(JSON.parse(content)),
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${commit}:workflow/maintainer-policy.json`,
      ]).trim(),
    };
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_POLICY_INVALID',
      'Task mandate trust-base policy is unavailable or invalid.',
      ExitCode.guard,
    );
  }
}
export const taskMandateRepository: TaskMandateRepositoryServices = {
  discoverRepository,
  loadPolicyAt,
  createInteractiveSshSigner,
  isPostApprovalAdmissionFailure,
  repositoryHead(repositoryRoot) {
    return runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  },
  repositoryOrigin(repositoryRoot) {
    return runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  },
};
