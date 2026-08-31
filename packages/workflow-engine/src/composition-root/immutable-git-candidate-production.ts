import { pinCheckRunner } from '../adapters/consumer/repository/work-registry/check-runner.ts';
import {
  buildImmutableGitCandidateWithRuntimePort,
  verifyImmutableGitCandidateAgainstRepositoryWithRuntimePort,
  verifyImmutableGitCandidateObjectsWithRuntimePort,
  type BuildImmutableGitCandidateOptions,
  type BuildImmutableGitCandidateRequest,
  type ImmutableGitCandidateRuntimePort,
  type ImmutableGitCandidateV1,
} from '../modules/authority/immutable-git-candidate.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
  runGitBuffer,
} from '../runtime/repository-transaction/git.ts';
import { previewExactStaging } from '../runtime/repository-transaction/git-transitions.ts';

const immutableGitCandidateRuntimePort = Object.freeze({
  discoverRepository,
  fingerprintWorkingState,
  listChangedPaths,
  pinCheckRunner,
  previewExactStaging,
  runGit,
  runGitBuffer,
}) satisfies ImmutableGitCandidateRuntimePort;

export function buildImmutableGitCandidate(
  cwd: string,
  request: BuildImmutableGitCandidateRequest,
  options: BuildImmutableGitCandidateOptions = {},
): ImmutableGitCandidateV1 {
  return buildImmutableGitCandidateWithRuntimePort(
    immutableGitCandidateRuntimePort,
    cwd,
    request,
    options,
  );
}

export function verifyImmutableGitCandidateAgainstRepository(
  cwd: string,
  value: ImmutableGitCandidateV1,
): ImmutableGitCandidateV1 {
  return verifyImmutableGitCandidateAgainstRepositoryWithRuntimePort(
    immutableGitCandidateRuntimePort,
    cwd,
    value,
  );
}

export function verifyImmutableGitCandidateObjects(
  cwd: string,
  value: ImmutableGitCandidateV1,
): ImmutableGitCandidateV1 {
  return verifyImmutableGitCandidateObjectsWithRuntimePort(
    immutableGitCandidateRuntimePort,
    cwd,
    value,
  );
}

export {
  canonicalImmutableGitCandidate,
  parseImmutableGitCandidate,
} from '../modules/authority/immutable-git-candidate.ts';
export type {
  BuildImmutableGitCandidateOptions,
  BuildImmutableGitCandidateRequest,
  ImmutableGitCandidateV1,
} from '../modules/authority/immutable-git-candidate.ts';
