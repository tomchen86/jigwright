/** Exact live repository observations for maintainer grant admission. */
import fs from 'node:fs';
import path from 'node:path';
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import { maintainerGrantStorePaths } from '../storage-journal/maintainer-store.ts';
import { readDurableRefGenerationLedger } from '../storage-journal/maintainer-candidate-ref-ledger.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../../modules/authority/maintainer-policy.ts';
import { digest } from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { MaintainerGrantV2Services } from '../../modules/authority/maintainer-grant-v2.ts';
export const loadV2TrustContext: MaintainerGrantV2Services['loadV2TrustContext'] =
  function loadV2TrustContext(cwd, expectedBase) {
    const repository = discoverRepository(cwd);
    if (expectedBase && repository.head !== expectedBase) {
      throw workflowError(
        'MAINTAINER_PATCH_STALE_BASE',
        'The repository HEAD moved after maintainer grant preflight.',
        ExitCode.staleState,
      );
    }
    let policyContent: string;
    let policy: MaintainerPolicy;
    try {
      policyContent = runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]);
      policy = parseMaintainerPolicy(JSON.parse(policyContent));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        throw error;
      }
      throw workflowError(
        'MAINTAINER_POLICY_INVALID',
        'The trust base does not contain a valid maintainer policy.',
        ExitCode.guard,
      );
    }
    const origin = runGit(repository.repositoryRoot, [
      'remote',
      'get-url',
      'origin',
    ]).trim();
    if (origin !== policy.repository.origin) {
      throw workflowError(
        'MAINTAINER_REPOSITORY_MISMATCH',
        'The repository origin does not match the trusted maintainer policy.',
        ExitCode.guard,
      );
    }
    const policyBlob = resolveBlobOid(
      repository.repositoryRoot,
      repository.head,
      'workflow/maintainer-policy.json',
    );
    return {
      repository,
      policy,
      policyBlob,
      policyDigest: digest(policyContent),
    };
  };
export const assertUnusedGrant: MaintainerGrantV2Services['assertUnusedGrant'] =
  function assertUnusedGrant(repository, grantId, tagRef) {
    const paths = maintainerGrantStorePaths(repository.gitCommonDirectory);
    const availableTokenPath = path.join(paths.available, `${grantId}.json`);
    if (
      fs.existsSync(availableTokenPath) ||
      fs.existsSync(path.join(paths.reserved, `${grantId}.json`)) ||
      fs.existsSync(path.join(paths.terminal, `${grantId}.json`)) ||
      runGit(
        repository.repositoryRoot,
        ['rev-parse', '--verify', tagRef],
        true,
      ).trim()
    ) {
      throw workflowError(
        'MAINTAINER_GRANT_EXISTS',
        `Maintainer grant ${grantId} already has local state or an audit tag.`,
        ExitCode.conflict,
      );
    }

    return availableTokenPath;
  };
export const readRequiredRefGenerationLedger: MaintainerGrantV2Services['readRequiredRefGenerationLedger'] =
  function readRequiredRefGenerationLedger(gitCommonDirectory, ref) {
    return readDurableRefGenerationLedger(gitCommonDirectory, ref, true);
  };
export const readTargetRef: MaintainerGrantV2Services['readTargetRef'] =
  function readTargetRef(repositoryRoot, targetRef) {
    return runGit(
      repositoryRoot,
      ['rev-parse', '--verify', targetRef],
      true,
    ).trim();
  };
export const readPolicyContent: MaintainerGrantV2Services['readPolicyContent'] =
  function readPolicyContent(repositoryRoot, baseCommit) {
    return runGit(repositoryRoot, [
      'show',
      `${baseCommit}:workflow/maintainer-policy.json`,
    ]);
  };

import { maintainerChecksEnvironmentDigest } from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { resolveBlobOid } from '../repository-transaction/git-object-ids.ts';
/** Resolves database identity only when the original check evidence requires it. */
export function createMaintainerChecksEnvironmentDigest(
  databaseIdentity: (
    repositoryRoot: string,
    environment: NodeJS.ProcessEnv,
  ) => string,
): MaintainerGrantV2Services['currentChecksEnvironmentDigest'] {
  return function currentChecksEnvironmentDigest(
    repositoryRoot,
    attestation,
    environment,
  ) {
    const destructive = attestation.checks.some(
      ({ evidence }) => evidence.destructiveDatabase,
    );
    return maintainerChecksEnvironmentDigest(
      destructive ? databaseIdentity(repositoryRoot, environment) : null,
    );
  };
}
