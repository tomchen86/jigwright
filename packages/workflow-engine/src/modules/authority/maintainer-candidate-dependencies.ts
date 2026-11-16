/** Canonical candidate dependency projections and required observation contracts. */
import type {
  CandidateChecksAttestationV3,
  CandidateDependencySnapshot,
} from './maintainer-candidate-contracts.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';

export function sealedCandidateDependencySnapshot(input: {
  candidateTree: string;
  baseCommit: string;
  harnessEngineDigest: string;
  policyDigest: string;
  checks: CandidateChecksAttestationV3['checks'];
}): CandidateDependencySnapshot {
  return {
    schemaVersion: 1,
    sourceTree: input.candidateTree,
    baseCommit: input.baseCommit,
    harnessEngineDigest: input.harnessEngineDigest,
    policyDigest: input.policyDigest,
    runnerDigests: Object.fromEntries(
      input.checks.map((check) => [check.checkId, check.runnerDigest]),
    ),
    externalStateDigests: Object.fromEntries(
      input.checks.map((check) => [
        check.checkId,
        check.dependsOn.includes('external-state')
          ? check.externalSnapshotDigest
          : null,
      ]),
    ),
  };
}

export type CandidateHarnessEngineDigestReader = (
  repository: GitState,
  repositoryId: string,
  environment: NodeJS.ProcessEnv,
) => string;

export type CandidateDependencySnapshotReader = (input: {
  cwd: string;
  repositoryId: string;
  candidateTree: string;
  baseCommit: string;
  policyDigest: string;
  checks: CandidateChecksAttestationV3['checks'];
  environment?: NodeJS.ProcessEnv;
  externalStateDigests?: Readonly<Record<string, string>>;
}) => CandidateDependencySnapshot;

export type CandidateDependencyObservations = {
  currentCandidateDependencySnapshot: CandidateDependencySnapshotReader;
  resolveCandidateHarnessEngineDigest: CandidateHarnessEngineDigestReader;
};

import type { CheckRunnerPin } from '../source/check-command.ts';
export type CandidateDependencyObservationBindings = {
  pinCheckRunner: CheckRunnerPin;
  resolveCandidateHarnessEngineDigest: CandidateHarnessEngineDigestReader;
  currentEnvironment: () => NodeJS.ProcessEnv;
};

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';
import type { CheckDefinition } from '../source/check-command.ts';
const DIGEST = /^[0-9a-f]{64}$/;

export function assertCandidateDependencyTrustBase(
  head: string,
  baseCommit: string,
): void {
  if (head !== baseCommit) {
    throw workflowError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Candidate dependency freshness requires the exact trust-base commit.',
      ExitCode.staleState,
    );
  }
}

export function assertCandidateDependencyPolicyBinding(
  policy: MaintainerPolicy,
  policyDigest: string,
  input: Parameters<CandidateDependencySnapshotReader>[0],
): void {
  if (
    policy.repository.id !== input.repositoryId ||
    policyDigest !== input.policyDigest
  ) {
    throw workflowError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Candidate dependency freshness differs from its trust-base policy.',
      ExitCode.staleState,
    );
  }
}

export function candidateExternalStateDigests(
  input: Parameters<CandidateDependencySnapshotReader>[0],
): Record<string, string | null> {
  return Object.fromEntries(
    input.checks.map((check) => {
      const current = input.externalStateDigests?.[check.checkId];
      if (!check.dependsOn.includes('external-state')) {
        return [check.checkId, null];
      }
      if (typeof current !== 'string' || !DIGEST.test(current)) {
        throw workflowError(
          'APPLY_ATTESTATION_EXTERNAL_STATE_REQUIRED',
          `Check ${check.checkId} requires a trusted current external-state snapshot.`,
          ExitCode.staleState,
        );
      }
      return [check.checkId, current];
    }),
  );
}

export function parseCandidateCheckDefinitions(
  source: string,
  requiredChecks: string[],
): Record<string, CheckDefinition> {
  try {
    const raw = JSON.parse(source) as {
      schemaVersion?: unknown;
      checks?: unknown;
    };
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.checks !== 'object' ||
      raw.checks === null ||
      Array.isArray(raw.checks)
    ) {
      throw new Error('invalid base checks');
    }
    const checks = raw.checks as Record<string, unknown>;
    return Object.fromEntries(
      requiredChecks.map((checkId) => {
        const definition = checks[checkId] as
          Partial<CheckDefinition> | undefined;
        if (
          !definition ||
          !Array.isArray(definition.command) ||
          !definition.command.every((part) => typeof part === 'string') ||
          typeof definition.destructiveDatabase !== 'boolean'
        ) {
          throw new Error(`invalid base check ${checkId}`);
        }
        return [
          checkId,
          {
            command: [...definition.command],
            destructiveDatabase: definition.destructiveDatabase,
          },
        ];
      }),
    );
  } catch (error) {
    throwCandidateCheckDefinitionReadError(error);
  }
}

export function throwCandidateCheckDefinitionReadError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error) throw error;
  throw workflowError(
    'AUTHORITY_CHECK_INVALID',
    'Required check definitions are unavailable from the exact grant base.',
    ExitCode.guard,
  );
}
