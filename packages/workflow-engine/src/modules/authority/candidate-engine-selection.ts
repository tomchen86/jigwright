/** Selects the exact current engine dependency from required, freshly verified observations. */
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { CandidateHarnessEngineDigestReader } from './maintainer-candidate-dependencies.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

/** Only facts used by candidate admission cross the bootstrap boundary. */
export type CandidateEngineSelectionSources = {
  bootstrapInterventionStateRoot: (gitCommonDirectory: string) => string;
  resolveLocalEngineSelection: (
    storageRoot: string,
    identity: { worktreeRoot: string; branchRef: string | null },
  ) => { resumeBinding: { engineDigest: string } } | null;
  resolveControlPlaneEngineSelection: (
    storageRoot: string,
    repositoryId: string,
  ) => { activeArtifact: { closureDigest: string } } | null;
  BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST: string;
};

const DIGEST = /^[0-9a-f]{64}$/;

export function createCandidateHarnessEngineDigestReader({
  bootstrapInterventionStateRoot,
  resolveLocalEngineSelection,
  resolveControlPlaneEngineSelection,
  BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
}: CandidateEngineSelectionSources): CandidateHarnessEngineDigestReader {
  function resolveCandidateHarnessEngineDigest(
    repository: GitState,
    repositoryId: string,
    environment: NodeJS.ProcessEnv,
  ): string {
    const storageRoot = bootstrapInterventionStateRoot(
      repository.gitCommonDirectory,
    );
    const identity = {
      worktreeRoot: repository.repositoryRealPath,
      branchRef: repository.branch ? `refs/heads/${repository.branch}` : null,
    };
    const local = resolveLocalEngineSelection(storageRoot, identity);
    if (local !== null) {
      const raw = environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
      let parsed: unknown;
      try {
        parsed = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (
        parsed === undefined ||
        canonicalJson(parsed) !== canonicalJson(local.resumeBinding)
      ) {
        throw workflowError(
          'APPLY_ATTESTATION_ENGINE_BINDING_INVALID',
          'Candidate checks were not launched through the bootstrap-selected local engine.',
          ExitCode.staleState,
        );
      }
      return rawDigest(local.resumeBinding.engineDigest);
    }
    const global = resolveControlPlaneEngineSelection(
      storageRoot,
      repositoryId,
    );
    return rawDigest(
      global?.activeArtifact.closureDigest ??
        BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
    );
  }
  return resolveCandidateHarnessEngineDigest;
}

function rawDigest(value: string): string {
  const raw = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!DIGEST.test(raw)) {
    throw workflowError(
      'APPLY_ATTESTATION_ENGINE_BINDING_INVALID',
      'Candidate harness-engine dependency digest is invalid.',
      ExitCode.staleState,
    );
  }
  return raw;
}
