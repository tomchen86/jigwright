/**
 * Creates a Grant-selected local protected ref with a create-only Git transaction.
 *
 * Invariants:
 * - Local initialization verifies HEAD and creates the ref in one transaction.
 * - Prepared Grant recovery accepts only the exact already-created commit.
 * - Inspecting or choosing the local target never contacts a remote service.
 */
import { loadWorkflowConfig } from '../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { loadMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import {
  assertProtectedBaseInitializationParameters,
  type ProtectedBaseInitializationParametersV1,
} from '../modules/authority/protected-base-initialization-grant.ts';
import {
  assertLocalProtectedBaseParameters,
  initialLocalProtectedBaseObservation,
  type LocalProtectedBaseObservationV1,
  type ProtectedBaseSelectionPort,
} from '../modules/authority/protected-base-selection-grant.ts';
import {
  discoverRepository,
  runGit,
  runGitBuffer,
} from '../runtime/repository-transaction/git.ts';
import {
  canonicalRemoteIdentity,
  createProductionProtectedBaseInitializationPort,
} from './protected-base-initialization-production.ts';

export function createProductionProtectedBaseSelectionPort(
  cwd: string,
): ProtectedBaseSelectionPort {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observeLocal = (): LocalProtectedBaseObservationV1 => {
    const repository = discoverRepository(repositoryRoot);
    const policy = loadMaintainerPolicy(repositoryRoot);
    const observation = initialLocalProtectedBaseObservation({
      repositoryId: policy.repository.id,
      canonicalOrigin: policy.repository.origin,
      sourceCommit: repository.head,
      sourceTree: repository.tree,
    });
    const symbolic = runGit(
      repositoryRoot,
      ['symbolic-ref', '--quiet', observation.ref],
      true,
    ).trim();
    const commit = runGit(
      repositoryRoot,
      ['show-ref', '--verify', '--hash', observation.ref],
      true,
    ).trim();
    if (
      symbolic !== '' ||
      (commit !== '' &&
        runGit(repositoryRoot, ['cat-file', '-t', commit], true).trim() !==
          'commit')
    ) {
      throw localStateChanged();
    }
    return Object.freeze({ ...observation, localCommit: commit || null });
  };
  return Object.freeze({
    observeLocal,
    remoteParameters(): ProtectedBaseInitializationParametersV1 | null {
      const local = observeLocal();
      const fetchUrl = runGit(
        repositoryRoot,
        ['remote', 'get-url', 'origin'],
        true,
      ).trim();
      const pushUrl = runGit(
        repositoryRoot,
        ['remote', 'get-url', '--push', 'origin'],
        true,
      ).trim();
      if (
        fetchUrl === '' ||
        pushUrl === '' ||
        canonicalRemoteIdentity(fetchUrl) !== local.canonicalOrigin ||
        canonicalRemoteIdentity(pushUrl) !== local.canonicalOrigin
      ) {
        return null;
      }
      return assertProtectedBaseInitializationParameters({
        schemaVersion: 1,
        kind: 'protected-base-initialization-authorization.v1',
        repositoryId: local.repositoryId,
        canonicalOrigin: local.canonicalOrigin,
        remoteName: 'origin',
        fetchUrl,
        pushUrl,
        protectedBranch:
          loadWorkflowConfig(repositoryRoot).protectedBranches[0],
        sourceCommit: local.sourceCommit,
        sourceTree: local.sourceTree,
      });
    },
    observeRemote() {
      return createProductionProtectedBaseInitializationPort(
        repositoryRoot,
      ).observe();
    },
    initializeLocal(parameters, recovered, assertOwned) {
      assertOwned();
      const expected = assertLocalProtectedBaseParameters(parameters);
      const observed = observeLocal();
      if (
        observed.repositoryId !== expected.repositoryId ||
        observed.canonicalOrigin !== expected.canonicalOrigin ||
        observed.ref !== expected.ref
      ) {
        throw localStateChanged();
      }
      if (recovered && observed.localCommit === expected.sourceCommit) {
        return 'recovered';
      }
      if (
        observed.sourceCommit !== expected.sourceCommit ||
        observed.sourceTree !== expected.sourceTree ||
        observed.localCommit !== null
      ) {
        throw localStateChanged();
      }
      assertOwned();
      try {
        runGitBuffer(repositoryRoot, ['update-ref', '--stdin'], {
          input: Buffer.from(
            `start\nverify HEAD ${expected.sourceCommit}\ncreate ${expected.ref} ${expected.sourceCommit}\nprepare\ncommit\n`,
          ),
        });
      } catch {
        throw localStateChanged();
      }
      return 'created';
    },
  });
}

function localStateChanged() {
  return workflowError(
    'LOCAL_PROTECTED_BASE_STATE_CHANGED',
    'The local protected-base target or source changed; its exact Grant cannot overwrite that state.',
    ExitCode.staleState,
  );
}
