/** Live external-effect policy, source and private audit-directory observations. */
import fs from 'node:fs';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  isWorkflowFailure,
  assertExternalAuditRootPath,
} from '../../modules/authority/external-effect-grant.ts';

import { runGit } from '../repository-transaction/git.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';

import { type ExternalEffectRepositoryServices } from '../../modules/authority/external-effect-grant-services.ts';
const loadPolicyAt: ExternalEffectRepositoryServices['loadPolicyAt'] =
  function loadPolicyAt(repositoryRoot, commit) {
    try {
      const content = runGit(repositoryRoot, [
        'show',
        `${commit}:workflow/maintainer-policy.json`,
      ]);
      return {
        policy: parseMaintainerPolicy(JSON.parse(content)),
        policyBlob: resolveBlobOid(
          repositoryRoot,
          commit,
          'workflow/maintainer-policy.json',
        ),
      };
    } catch (error) {
      if (isWorkflowFailure(error)) throw error;
      throw workflowError(
        'EXTERNAL_EFFECT_REPOSITORY_MISMATCH',
        'External effect trust base could not be loaded.',
        ExitCode.verification,
      );
    }
  };
const assertExternalAuditRoot: ExternalEffectRepositoryServices['assertExternalAuditRoot'] =
  function assertExternalAuditRoot(value, repositoryRoot) {
    assertExternalAuditRootPath(value, repositoryRoot);
    const stats = fs.lstatSync(value, { throwIfNoEntry: false });
    if (
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o700 ||
      fs.realpathSync(value) !== value
    ) {
      throw workflowError(
        'EXTERNAL_EFFECT_AUDIT_ROOT_INVALID',
        'External effect audit root is missing, linked, or not private.',
        ExitCode.guard,
      );
    }
    return value;
  };
export const externalEffectRepository: Omit<
  ExternalEffectRepositoryServices,
  'createInteractiveSshSigner'
> = {
  discoverRepository,
  loadPolicyAt,
  assertExternalAuditRoot,
  repositoryOrigin: (repositoryRoot) =>
    runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim(),
  resolveSourceOid: (repositoryRoot, sourceOid) =>
    runGit(repositoryRoot, ['rev-parse', '--verify', sourceOid]).trim(),
};

import { discoverRepository } from '../repository-transaction/git.ts';

import { type PublishRepositoryServices } from '../../modules/authority/publish-grant.ts';
import { resolveBlobOid } from '../repository-transaction/git-object-ids.ts';
export const publishRepository: PublishRepositoryServices = {
  discoverRepository,
  resolveSourceOid: externalEffectRepository.resolveSourceOid,
  remoteUrl: (repositoryRoot, remoteName) =>
    runGit(repositoryRoot, ['remote', 'get-url', remoteName]).trim(),
};
