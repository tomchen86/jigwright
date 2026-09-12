import { openSpecPlanningPathPolicy } from '../adapters/planning/openspec/documents/planning-path-policy.ts';
import type { PlanningPathPolicy } from '../modules/source/planning-paths.ts';
import { loadChangeContract as productionChangeContractReader } from './consumer-contract-production.ts';
const loadValidatedChangeContract =
  loadValidatedChangeContractWithContractReader.bind(
    undefined,
    productionChangeContractReader,
  );
/**
 * Loads stable validated planning contracts and exposes their routing
 * authority facts.
 *
 * Invariants:
 * - Validation rejects repository identity or projection changes and
 *   requires the configured current schema.
 */
import { productionPlanningAssurance } from './planning-assurance-production.ts';
import type { PlanningAssurancePort } from '../modules/assurance/planning-assurance-port.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  type GitState,
} from '../runtime/repository-transaction/git.ts';
import { loadValidatedChangeContract as loadValidatedChangeContractWithContractReader } from '../adapters/planning/openspec/documents/managed-change-contract.ts';
import type { ValidatedChangeContract } from '../modules/assurance/validated-change-contract.ts';
import { createOpenSpecPlanningProviderPort } from './openspec-planning-provider-production.ts';
import { planningProviderBindingReader } from '../runtime/repository-transaction/planning-provider-binding-store.ts';
import { productionConsumedPlanReviewReplayPort } from './grant-verifier-composition.ts';

import type {
  ChangeRoutingAuthorityFacts,
  ChangeRoutingAuthorityPort,
} from '../modules/lifecycle/change-routing.ts';
import { loadRepositoryConsumerConfiguration } from '../runtime/repository-observation/repository-consumer.ts';
import type { SystemDescriptionSnapshot } from '../modules/source/spec-ownership.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';
import type { ConsumedRoleReplayPort } from '../modules/provider-orchestration/role-admission-contracts.ts';

export const productionChangeRoutingAuthorityPort: ChangeRoutingAuthorityPort =
  Object.freeze({
    loadCurrentAuthority(
      repositoryRoot: string,
      changeId: string,
    ): ChangeRoutingAuthorityFacts {
      const { contract } = loadStableValidatedChangeContract(
        discoverRepository(repositoryRoot),
        changeId,
      );
      const investigation = contract.investigation;
      const assurance = contract.planningAssurance;
      if (investigation === undefined || assurance === null) {
        throw workflowError(
          'CHANGE_ROUTING_CURRENT_AUTHORITY_REQUIRED',
          `Change ${changeId} does not have current Manifest v3 and separate PlanReview authority.`,
          ExitCode.verification,
        );
      }
      return Object.freeze({
        changeId,
        manifestDigest: investigation.validation.manifestDigest,
        investigationTargetDigest:
          investigation.validation.investigationTargetDigest,
        planningGenerationId: assurance.planningGenerationId,
        planTargetDigest: assurance.planTargetDigest,
        reviewNodeId: assurance.reviewNodeId,
        reviewResultDigest: assurance.reviewResultDigest,
        reviewRoleResultDigest: assurance.reviewRoleResultDigest,
      });
    },
  });

export function currentRepositorySchemaName(repositoryRoot: string): string {
  return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
    .planning.currentSchemaName;
}

export function loadStableValidatedChangeContract(
  initialGit: GitState,
  changeId: string,
): {
  git: GitState;
  contract: ValidatedChangeContract;
  consumedPlanReviewReplay: ConsumedRoleReplayPort;
  planningAssurance: PlanningAssurancePort;
  planningPaths: PlanningPathPolicy;
  readSystemDescription(): SystemDescriptionSnapshot;
} {
  const beforeFingerprint = fingerprintRepositoryProjection(
    initialGit.repositoryRoot,
    initialGit.head,
    initialGit.statusEntries,
  );
  const contract = loadValidatedChangeContract(
    initialGit.repositoryRoot,
    changeId,
    planningProviderBindingReader,
    productionConsumedPlanReviewReplayPort,
    createOpenSpecPlanningProviderPort(
      initialGit.repositoryRoot,
      loadRepositoryConsumerConfiguration(initialGit.repositoryRoot)
        .configuration.planning,
    ),
    productionPlanningAssurance,
  );
  const git = discoverRepository(initialGit.repositoryRoot);
  const afterFingerprint = fingerprintRepositoryProjection(
    git.repositoryRoot,
    git.head,
    git.statusEntries,
  );
  if (
    git.repositoryRealPath !== initialGit.repositoryRealPath ||
    git.gitCommonDirectory !== initialGit.gitCommonDirectory ||
    git.branch !== initialGit.branch ||
    git.head !== initialGit.head ||
    git.tree !== initialGit.tree ||
    afterFingerprint !== beforeFingerprint
  ) {
    throw workflowError(
      'OPENSPEC_MUTATED_REPOSITORY',
      'OpenSpec validation changed the repository projection.',
      ExitCode.staleState,
    );
  }
  const currentSchemaName = currentRepositorySchemaName(
    initialGit.repositoryRoot,
  );
  if (contract.schemaName !== currentSchemaName) {
    throw workflowError(
      'OPENSPEC_LEGACY_SCHEMA_FORBIDDEN',
      `Active changes must use the configured current schema ${currentSchemaName} with a v3 investigation Manifest.`,
      ExitCode.verification,
    );
  }
  return {
    git,
    contract,
    consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
    planningAssurance: productionPlanningAssurance,
    planningPaths: openSpecPlanningPathPolicy,
    readSystemDescription: () =>
      readSystemDescriptionSnapshot(git.repositoryRoot),
  };
}
