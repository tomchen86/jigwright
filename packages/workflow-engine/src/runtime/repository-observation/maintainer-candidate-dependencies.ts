/** Observes exact candidate policy, runner identity and current dependency facts. */
import crypto from 'node:crypto';
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type { CheckDefinition } from '../../modules/source/check-command.ts';
import type {
  CandidateDependencySnapshotReader,
  CandidateDependencyObservationBindings,
} from '../../modules/authority/maintainer-candidate-dependencies.ts';
const DIGEST = /^[0-9a-f]{64}$/;
export function createCandidateDependencyObservations({
  pinCheckRunner,
  resolveCandidateHarnessEngineDigest,
  currentEnvironment,
}: CandidateDependencyObservationBindings) {
  const currentCandidateDependencySnapshot: CandidateDependencySnapshotReader =
    function currentCandidateDependencySnapshot(input) {
      const repository = discoverRepository(input.cwd);
      assertCandidateDependencyTrustBase(repository.head, input.baseCommit);
      const policyContent = runGit(repository.repositoryRoot, [
        'show',
        `${input.baseCommit}:workflow/maintainer-policy.json`,
      ]);
      const policy = parseMaintainerPolicy(JSON.parse(policyContent));
      const policyDigest = digest(policyContent);
      assertCandidateDependencyPolicyBinding(policy, policyDigest, input);
      const definitions = loadCandidateCheckDefinitions(
        repository.repositoryRoot,
        input.baseCommit,
        input.checks.map(({ checkId }) => checkId),
      );
      const runnerDigests = Object.fromEntries(
        input.checks.map(({ checkId }) => [
          checkId,
          pinCheckRunner(
            repository.repositoryRoot,
            checkId,
            definitions[checkId]!,
          ).digest,
        ]),
      );
      const externalStateDigests = candidateExternalStateDigests(input);
      return {
        schemaVersion: 1,
        sourceTree: input.candidateTree,
        baseCommit: input.baseCommit,
        harnessEngineDigest: resolveCandidateHarnessEngineDigest(
          repository,
          input.repositoryId,
          input.environment ?? currentEnvironment(),
        ),
        policyDigest,
        runnerDigests,
        externalStateDigests,
      };
    };

  return {
    currentCandidateDependencySnapshot,
    resolveCandidateHarnessEngineDigest,
  };
}
function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function loadCandidateCheckDefinitions(
  repositoryRoot: string,
  baseCommit: string,
  requiredChecks: string[],
): Record<string, CheckDefinition> {
  try {
    return parseCandidateCheckDefinitions(
      runGit(repositoryRoot, ['show', `${baseCommit}:workflow/checks.json`]),
      requiredChecks,
    );
  } catch (error) {
    throwCandidateCheckDefinitionReadError(error);
  }
}

import {
  assertCandidateDependencyTrustBase,
  assertCandidateDependencyPolicyBinding,
  candidateExternalStateDigests,
  parseCandidateCheckDefinitions,
  throwCandidateCheckDefinitionReadError,
} from '../../modules/authority/maintainer-candidate-dependencies.ts';
